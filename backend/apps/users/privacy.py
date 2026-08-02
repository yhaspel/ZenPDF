"""Account deletion and data export (§10.1 "Privacy").

Two obligations the legal pages state, implemented rather than promised.

**Export** is a zip of the person's current documents plus a manifest — what we
hold, in a form they can open without us. It runs inline rather than as a job
because it is bounded by their own storage quota and because a download that
needs polling is a download most people abandon.

**Deletion** is the harder one, and the shape here is deliberate:

* Documents, versions, blobs, jobs, saved signatures and uploaded assets go.
* **A completed signature envelope does not.** It is the other parties'
  evidence of an agreement — the counterparty who signed a contract has a legal
  interest in the record surviving the sender closing their account. So the
  envelope stays and the *account's* identifying data is removed from it; the
  privacy policy says this in as many words, and this is where that sentence
  becomes true.
* An **open** request is canceled first: leaving one live would keep mailing
  strangers in the name of an account that no longer exists.
"""
from __future__ import annotations

import io
import json
import logging
import zipfile

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

#: Deleting a whole library one blob at a time is slow, and a person waiting on
#: the response is not the right place for it — but a background job that fails
#: silently leaves them believing they are gone. So it runs inline, and this is
#: the ceiling above which we refuse and ask them to empty the trash first.
MAX_INLINE_DELETE_DOCUMENTS = 500


def export_zip(user) -> tuple[bytes, str]:
    """Everything we hold for this account, as a zip they can open offline."""
    from apps.core import limits as L
    from apps.core.principals import owned_by
    from apps.documents.models import Document
    from apps.esign.models import SignRequest
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    buf = io.BytesIO()
    manifest = {
        "account": {
            "email": user.email,
            "display_name": user.display_name,
            "joined": user.date_joined.isoformat(),
            "email_verified": user.email_verified,
            "accepted_terms_at": (user.accepted_tos_at.isoformat()
                                  if user.accepted_tos_at else None),
        },
        "exported_at": timezone.now().isoformat(),
        "documents": [],
        "signature_requests": [],
        "storage_bytes_used": L.storage_used(user),
    }

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        used = set()
        for document in owned_by(
                Document.objects.select_related("current_version"), user):
            entry = {
                "id": str(document.id),
                "title": document.title,
                "pages": document.page_count,
                "size_bytes": document.size_bytes,
                "created": document.created_at.isoformat(),
                "in_trash": document.trashed_at is not None,
                "versions": document.versions.count(),
            }
            version = document.current_version
            if version is not None:
                name = _unique(f"documents/{document.title}", used, ".pdf")
                try:
                    archive.writestr(name, storage.get_bytes(version.storage_key))
                    entry["file"] = name
                except Exception:  # noqa: BLE001 - a missing blob is not a reason
                    logger.exception("export: could not read %s", version.storage_key)
                    entry["file"] = None
            manifest["documents"].append(entry)

        for request in owned_by(SignRequest.objects.all(), user):
            manifest["signature_requests"].append({
                "envelope": request.envelope_code,
                "title": request.title,
                "status": request.status,
                "created": request.created_at.isoformat(),
                "recipients": [r.email for r in request.recipients.all()],
            })
            if request.final_key:
                name = _unique(f"signed/{request.title}", used, ".pdf")
                try:
                    archive.writestr(name, storage.get_bytes(request.final_key))
                except Exception:  # noqa: BLE001
                    logger.exception("export: could not read %s", request.final_key)

        archive.writestr("manifest.json", json.dumps(manifest, indent=2))
        archive.writestr("README.txt", _README)

    return buf.getvalue(), f"zenpdf-export-{timezone.now():%Y-%m-%d}.zip"


_README = """\
This is everything ZenPDF holds for your account.

  documents/    your files, as they are now
  signed/       completed signature envelopes you sent
  manifest.json the metadata: titles, dates, sizes, recipients

Signature envelopes that other people signed are also kept on our side as
evidence of the agreement, for as long as the law requires — deleting your
account does not delete the other parties' copy of a contract they signed.
That is stated in the privacy policy, and it is the one thing deletion does
not remove.
"""


def _unique(stem: str, used: set[str], suffix: str) -> str:
    """Two documents called "Invoice" must not become one file in the zip."""
    safe = "".join(c for c in stem if c.isalnum() or c in " ._-/").strip() or "document"
    name = f"{safe}{suffix}"
    index = 2
    while name in used:
        name = f"{safe} ({index}){suffix}"
        index += 1
    used.add(name)
    return name


@transaction.atomic
def delete_account(user) -> dict:
    """Erase the account. Returns what was removed, for the response and logs."""
    from apps.core.exceptions import ValidationFailed
    from apps.core.principals import owned_by
    from apps.documents.models import Document
    from apps.esign.models import SignRequest
    from apps.pdf_engine.storage import get_storage

    documents = owned_by(Document.objects.all(), user)
    if documents.count() > MAX_INLINE_DELETE_DOCUMENTS:
        raise ValidationFailed(
            f"This account holds more than {MAX_INLINE_DELETE_DOCUMENTS} "
            "documents. Write to us and we will do it by hand — we would "
            "rather that than half-delete an account."
        )

    # An open request left running would keep mailing strangers in the name of
    # an account that no longer exists.
    canceled = 0
    for request in owned_by(SignRequest.objects.all(), user).filter(
            status__in=SignRequest.OPEN_STATUSES):
        request.status = SignRequest.Status.CANCELED
        request.save(update_fields=["status"])
        canceled += 1

    storage = get_storage()
    blobs = 0
    for document in documents:
        for version in document.versions.all():
            try:
                storage.delete(version.storage_key)
                blobs += 1
            except Exception:  # noqa: BLE001 - a missing blob must not block
                logger.exception("delete_account: blob %s", version.storage_key)

    for signature in user.signatures.all():
        try:
            storage.delete(signature.storage_key)
            blobs += 1
        except Exception:  # noqa: BLE001
            pass

    removed = {
        "documents": documents.count(),
        "blobs": blobs,
        "sign_requests_canceled": canceled,
        # Envelopes kept as evidence for the people who signed them.
        "sign_requests_retained": owned_by(
            SignRequest.objects.all(), user
        ).exclude(status__in=SignRequest.OPEN_STATUSES).count(),
    }

    # Detach first. `source_version` is `PROTECT` — it exists so a live
    # envelope cannot lose what was signed — but the evidence a *closed*
    # envelope carries is the sealed PDF in storage, not the document row, and
    # leaving the reference in place would block the deletion entirely.
    _detach_envelopes(user)
    for document in documents:
        document.delete()

    user.delete()
    return removed


def _detach_envelopes(user) -> None:
    """Keep the record, cut it loose from the account.

    The envelope survives — it is the counterparty's evidence — carrying the
    sealed PDF, the certificate and the audit chain. What goes is the link to
    the account: `owner` and `document` are `SET_NULL`, and `source_version` is
    cleared here so the document rows can actually be deleted.

    The audit chain is **not** rewritten. It is append-only and hash-linked, so
    editing a row would break every hash after it and destroy the very thing
    being kept; the sender's address survives inside it, which is what an
    evidentiary record is for. The privacy policy says so.
    """
    from apps.core.principals import owned_by
    from apps.esign.models import SignRequest

    owned_by(SignRequest.objects.all(), user).update(source_version=None,
                                                     document=None)
