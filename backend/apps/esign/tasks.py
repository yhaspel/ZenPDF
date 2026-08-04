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

    from apps.pdf_engine.geometry import NormRect

    storage = get_storage()
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        for field in sign_request.fields.select_related("recipient").all():
            if field.page >= doc.page_count:
                continue
            page = doc[field.page]
            # `_place_rect` de-rotates: `insert_image` and `insert_textbox`
            # write in the page's unrotated space, so on a landscape page a
            # field placed at the top-left was landing off the right edge.
            rect = SG._place_rect(page, NormRect.from_dict(field.rect()))

            if field.type in SignField.IMAGE_TYPES:
                if not field.image_key:
                    continue
                page.insert_image(rect, stream=storage.get_bytes(field.image_key),
                                  overlay=True,
                                  rotate=SG._counter_rotation(page))
            elif field.type == SignField.Type.DATE_SIGNED:
                when = field.recipient.completed_at or timezone.now()
                # `fit_text`, not `insert_textbox`: the latter returns a
                # negative number and writes *nothing* when the text does not
                # fit, so a date in a box somebody drew thin simply vanished
                # from the finished document.
                SG.fit_text(page, rect, when.strftime("%Y-%m-%d %H:%M UTC"))
            elif field.type == SignField.Type.CHECKBOX:
                if field.value == "true":
                    SG.fit_text(page, rect, "X", max_size=12)
            elif field.value:
                SG.fit_text(page, rect, field.value)
        return doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()


@shared_task(name="apps.esign.tasks.finalize_sign_request")
def finalize_sign_request(sign_request_id: str) -> dict:
    """Burn → stamp → seal → certificate → store → notify (§8B step 3–6).

    The whole body runs under the §11 Redis lock. A status check on its own was
    not enough: two recipients in a parallel group finishing in the same
    instant both saw "everyone is done" and both dispatched, and because the
    seal was written to storage *before* the status was claimed, the loser's
    bytes could land on top of the winner's — leaving `final_sha256` describing
    a file nobody has. The lock makes the second dispatch see a completed
    request and return.
    """
    from apps.documents.tasks import doc_lock

    with doc_lock(f"sign-{sign_request_id}"):
        return _finalize(sign_request_id)


def _finalize(sign_request_id: str) -> dict:
    sign_request = (SignRequest.objects
                    .select_related("owner", "document", "source_version")
                    .get(id=sign_request_id))
    if sign_request.status == SignRequest.Status.COMPLETED:
        # Not "already done, nothing to do". `acks_late` is on for the heavy
        # lane, so this branch is exactly where a task redelivered after a kill
        # lands — and the kill may have happened between the COMPLETED commit
        # and the end of the tail, leaving no certificate, no completion events
        # and no notification, permanently. Finish whatever is missing.
        return {"already": True, **_finalize_tail(sign_request)}
    if sign_request.status != SignRequest.Status.SENT:
        return {"skipped": sign_request.status}

    version = sign_request.source_version
    if version is None:
        # Frozen at send, so this cannot happen for a `sent` request — unless
        # the account was deleted and the envelope detached (§10.1), in which
        # case there is nothing left to seal and saying so beats a 500.
        return {"skipped": "source version is gone"}

    storage = get_storage()
    source = storage.get_bytes(version.storage_key)

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

    with transaction.atomic():
        locked = (SignRequest.objects.select_for_update()
                  .get(id=sign_request.id))
        if locked.status == SignRequest.Status.COMPLETED:
            # Belt and braces behind the Redis lock: a lock that expired under
            # a very slow seal must not produce two files either.
            return {"already": True, "envelope": locked.envelope_code}
        # Stored *inside* the claim, so the bytes and the fingerprint that
        # describes them are committed together.
        storage.put_bytes(final_key, sealed, content_type="application/pdf")
        locked.final_key = final_key
        locked.final_sha256 = final_sha
        locked.status = SignRequest.Status.COMPLETED
        locked.completed_at = timezone.now()
        locked.save(update_fields=["final_key", "final_sha256", "status",
                                   "completed_at"])
    sign_request.refresh_from_db()

    return _finalize_tail(sign_request, seal_report=seal_report)


def _finalize_tail(sign_request, *, seal_report: dict | None = None) -> dict:
    """Everything after the COMPLETED commit, written so it can run twice.

    This used to be the straight-line tail of `_finalize`, and it is the part a
    kill destroys. The status is committed first — it has to be, or two workers
    seal two different files — and `acks_late` on the `heavy` lane means a
    worker killed in the next few seconds is redelivered. The redelivery then
    saw COMPLETED, returned `{"already": True}`, and the certificate, the
    completion events and the notification were gone for good: `certificate_key`
    stayed empty, so the download answered "not ready" for ever, and nobody was
    ever told the document was finished.

    So each step asks whether it has already happened. Three of them can answer
    from their own state; the email and the source-append cannot, and carry a
    timestamp apiece.
    """
    storage = get_storage()
    final_sha = sign_request.final_sha256

    if not sign_request.audit_events.filter(type="seal_applied").exists():
        # A resumed run no longer has the seal report in hand — it was produced
        # before the commit that survived. Recording the event without it beats
        # a gap in the chain the certificate prints, and it says which it is.
        record(sign_request, "seal_applied",
               **(seal_report if seal_report is not None else {"resumed": True}))
    if not sign_request.audit_events.filter(type="completed").exists():
        record(sign_request, "completed", sha256=final_sha)

    # The certificate is built *after* the completion events so that it can
    # print them — it is the record of the whole envelope, including its end.
    if not sign_request.certificate_key:
        cert = certificate.build(sign_request)
        cert_key = f"sign/{sign_request.id}/certificate.pdf"
        storage.put_bytes(cert_key, cert, content_type="application/pdf")
        sign_request.certificate_key = cert_key
        sign_request.save(update_fields=["certificate_key"])

    if sign_request.source_appended_at is None:
        _append_to_source_document(sign_request)

    if sign_request.completed_notified_at is None:
        # The API's own tokenized download, not a front-end route:
        # `/s/final/{token}` matched nothing and fell through to the marketing
        # page, which is where every recipient's copy was pointing.
        base = f"{settings.API_BASE_URL}/api/public/sign/{{token}}/download"
        emails.notify_completed(sign_request,
                                final_url=f"{base}/final/",
                                certificate_url=f"{base}/certificate/")
        sign_request.completed_notified_at = timezone.now()
        sign_request.save(update_fields=["completed_notified_at"])

    return {"envelope": sign_request.envelope_code, "sha256": final_sha,
            **(seal_report or {})}


def _append_to_source_document(sign_request) -> None:
    """Owner convenience: the signed file lands as a new version of the source.

    Best-effort — the envelope is complete and stored either way, and a
    document the owner has since deleted must not fail the finalize.

    Since the storage quota moved onto the version write, an owner who is over
    quota is one of the reasons this can decline. That is the right answer for
    an unbounded write, and it costs the owner nothing they cannot recover: the
    sealed file is in the envelope and downloadable from the request either
    way. It is logged rather than surfaced because there is no job here to fail
    — the ceremony belongs to the signer, who did nothing wrong.

    The sealed bytes are read back from storage rather than passed in, because
    a resumed finalize does not have them: the only thing it inherits from the
    run that was killed is what that run committed.
    """
    from apps.documents.tasks import _save_new_version, doc_lock

    try:
        sealed = get_storage().get_bytes(sign_request.final_key)
        # Under the document's own lock, like every other writer into the
        # version pipeline (§11). Without it this is the one path that can race
        # an ordinary operation and lose the unique (document, seq) constraint —
        # failing the *user's* job with a generic engine error.
        with doc_lock(str(sign_request.document_id)):
            sign_request.document.refresh_from_db()
            _save_new_version(document=sign_request.document, data=sealed,
                              label="Signed", created_by=sign_request.owner,
                              job=None)
    except Exception:  # noqa: BLE001
        # Deliberately *not* marked done: the next resume gets to try again,
        # and a permanent reason (a deleted document) simply logs each time.
        logger.warning("finalize: could not append signed version to document %s",
                       sign_request.document_id, exc_info=True)
        return
    sign_request.source_appended_at = timezone.now()
    sign_request.save(update_fields=["source_appended_at"])


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
            if not emails.notify_reminder(sign_request, recipient):
                continue
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
