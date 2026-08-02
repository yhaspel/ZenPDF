"""Signing background work (phase-08 §8B, §15).

Three tasks: finalize a completed envelope, nudge people who have not acted,
and expire requests nobody finished.

`finalize_sign_request` is **idempotent** by construction — it is dispatched
from a request path that can fire twice (two recipients completing at the same
moment), and sealing twice would produce two different files, each claiming to
be the completed document.
"""
from __future__ import annotations

import hashlib
import logging

from celery import shared_task
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.pdf_engine.engine import seal as SEAL
from apps.pdf_engine.engine import signatures as SG
from apps.pdf_engine.storage import get_storage

from . import certificate, emails
from .models import Recipient, SignField, SignRequest, record

logger = logging.getLogger(__name__)


def _burn_fields(data: bytes, sign_request) -> bytes:
    """Write every filled field into the page content and flatten.

    Values become *content*, not annotations: a completed document must not
    have form fields anyone can edit, and a signature that can be dragged off
    the page is a picture.
    """
    import fitz

    from apps.pdf_engine.geometry import NormRect, norm_to_page_rect

    storage = get_storage()
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        for field in sign_request.fields.select_related("recipient").all():
            if field.page >= doc.page_count:
                continue
            page = doc[field.page]
            norm = NormRect.from_dict(field.rect())
            x0, y0, x1, y1 = norm_to_page_rect(norm, page.rect.width,
                                               page.rect.height)
            rect = fitz.Rect(x0, y0, x1, y1)

            if field.type in SignField.IMAGE_TYPES:
                if not field.image_key:
                    continue
                page.insert_image(rect, stream=storage.get_bytes(field.image_key),
                                  overlay=True)
            elif field.type == SignField.Type.DATE_SIGNED:
                when = field.recipient.completed_at or timezone.now()
                page.insert_textbox(rect, when.strftime("%Y-%m-%d %H:%M UTC"),
                                    fontsize=9, fontname="helv", color=(0, 0, 0))
            elif field.type == SignField.Type.CHECKBOX:
                if field.value == "true":
                    page.insert_textbox(rect, "X", fontsize=12, fontname="helv",
                                        color=(0, 0, 0))
            elif field.value:
                page.insert_textbox(rect, field.value, fontsize=9, fontname="helv",
                                    color=(0, 0, 0))
        return doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()


@shared_task(name="apps.esign.tasks.finalize_sign_request")
def finalize_sign_request(sign_request_id: str) -> dict:
    """Burn → stamp → seal → certificate → store → notify (§8B step 3–6)."""
    sign_request = (SignRequest.objects
                    .select_related("owner", "document", "source_version")
                    .get(id=sign_request_id))
    # Idempotency, first line: two recipients finishing in the same second both
    # dispatch this, and a second seal would produce a second file that also
    # claims to be *the* completed document.
    if sign_request.status == SignRequest.Status.COMPLETED:
        return {"already": True, "envelope": sign_request.envelope_code}
    if sign_request.status != SignRequest.Status.SENT:
        return {"skipped": sign_request.status}

    storage = get_storage()
    source = storage.get_bytes(sign_request.source_version.storage_key)

    data = _burn_fields(source, sign_request)
    data = SG.stamp_envelope_footer(
        data, code=sign_request.envelope_code,
        verify_url=f"{settings.FRONTEND_BASE_URL}/verify",
    )
    sealed, seal_report = SEAL.seal(
        data,
        reason=f"Completed via ZenPDF envelope {sign_request.envelope_code}",
        location=settings.FRONTEND_BASE_URL,
    )
    # The hash of the *sealed* file — the exact bytes everyone downloads, which
    # is the only fingerprint worth printing on a certificate.
    final_sha = hashlib.sha256(sealed).hexdigest()

    final_key = f"sign/{sign_request.id}/final.pdf"
    storage.put_bytes(final_key, sealed, content_type="application/pdf")

    with transaction.atomic():
        locked = (SignRequest.objects.select_for_update()
                  .get(id=sign_request.id))
        if locked.status == SignRequest.Status.COMPLETED:
            return {"already": True, "envelope": locked.envelope_code}
        locked.final_key = final_key
        locked.final_sha256 = final_sha
        locked.status = SignRequest.Status.COMPLETED
        locked.completed_at = timezone.now()
        locked.save(update_fields=["final_key", "final_sha256", "status",
                                   "completed_at"])
    sign_request.refresh_from_db()

    record(sign_request, "seal_applied", **seal_report)
    record(sign_request, "completed", sha256=final_sha)

    # The certificate is built *after* the completion events so that it can
    # print them — it is the record of the whole envelope, including its end.
    cert = certificate.build(sign_request)
    cert_key = f"sign/{sign_request.id}/certificate.pdf"
    storage.put_bytes(cert_key, cert, content_type="application/pdf")
    sign_request.certificate_key = cert_key
    sign_request.save(update_fields=["certificate_key"])

    _append_to_source_document(sign_request, sealed)

    base = f"{settings.FRONTEND_BASE_URL}/s"
    emails.notify_completed(sign_request,
                            final_url=f"{base}/final",
                            certificate_url=f"{base}/certificate")
    return {"envelope": sign_request.envelope_code, "sha256": final_sha,
            **seal_report}


def _append_to_source_document(sign_request, sealed: bytes) -> None:
    """Owner convenience: the signed file lands as a new version of the source.

    Best-effort — the envelope is complete and stored either way, and a
    document the owner has since deleted must not fail the finalize.
    """
    from apps.documents.tasks import _save_new_version

    try:
        _save_new_version(document=sign_request.document, data=sealed,
                          label="Signed", created_by=sign_request.owner, job=None)
    except Exception:  # noqa: BLE001
        logger.warning("finalize: could not append signed version to document %s",
                       sign_request.document_id, exc_info=True)


@shared_task(name="apps.esign.tasks.sign_reminders")
def sign_reminders() -> dict:
    """Nudge recipients who were asked and have not finished (§8B)."""
    now = timezone.now()
    sent = 0
    open_requests = SignRequest.objects.filter(status=SignRequest.Status.SENT)
    for sign_request in open_requests.select_related("owner").iterator():
        cadence = sign_request.reminder_every_days
        if not cadence:
            continue
        if sign_request.expires_at and sign_request.expires_at <= now:
            continue
        from .routing import current_group

        active = current_group(sign_request)
        if active is None:
            continue
        for recipient in sign_request.recipients.filter(order=active):
            if not recipient.acts or recipient.status in {
                Recipient.Status.COMPLETED, Recipient.Status.DECLINED,
                Recipient.Status.PENDING,
            }:
                continue
            last = recipient.last_notified_at
            if last and (now - last).days < cadence:
                continue
            emails.notify_reminder(sign_request, recipient)
            record(sign_request, "reminder_sent", recipient=recipient)
            sent += 1
    if sent:
        logger.info("sign_reminders: sent %s reminder(s)", sent)
    return {"reminders": sent}


@shared_task(name="apps.esign.tasks.sign_expirations")
def sign_expirations() -> dict:
    """Close requests nobody finished in time (§8B)."""
    now = timezone.now()
    expired = 0
    stale = SignRequest.objects.filter(status=SignRequest.Status.SENT,
                                       expires_at__lt=now)
    for sign_request in stale.select_related("owner").iterator():
        sign_request.status = SignRequest.Status.EXPIRED
        sign_request.save(update_fields=["status"])
        pending = [r for r in sign_request.recipients.all()
                   if r.acts and r.status != Recipient.Status.COMPLETED]
        record(sign_request, "expired", pending=[r.email for r in pending])
        emails.notify_expired(sign_request, pending)
        expired += 1
    if expired:
        logger.info("sign_expirations: expired %s request(s)", expired)
    return {"expired": expired}
