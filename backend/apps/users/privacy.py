"""Account deletion and data export (§10.1 "Privacy").

Two obligations the legal pages state, implemented rather than promised.

**Export** is a zip of the person's current documents plus a manifest — what we
hold, in a form they can open without us. It runs inline rather than as a job
because it is bounded by their own storage quota and because a download that
needs polling is a download most people abandon.

**Deletion** is the harder one, and the shape here is deliberate:

* Documents, versions, blobs, jobs, saved signatures and uploaded assets go.
* **A signed envelope does not.** It is the other parties' evidence of an
  agreement — the counterparty who signed a contract has a legal interest in
  the record surviving the sender closing their account. "Signed" means there
  is a sealed artifact (`final_key`): a request that was sent and never
  finished proves nothing, so keeping it would retain both sides' addresses
  and IPs for no purpose, and it is deleted with everything else.
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

    documents = owned_by(Document.objects.all(), user)
    if documents.count() > MAX_INLINE_DELETE_DOCUMENTS:
        raise ValidationFailed(
            f"This account holds more than {MAX_INLINE_DELETE_DOCUMENTS} "
            "documents. Write to us and we will do it by hand — we would "
            "rather that than half-delete an account."
        )

    # A draft has reached nobody, so there is nothing in it to be evidence of —
    # only a title and the addresses somebody typed. It goes with the account,
    # and it goes *first*, before the cancel pass below would give it a status
    # that makes it look like something that was sent.
    _delete_unsent_drafts(user)

    # A *sent* request left running would keep mailing strangers in the name of
    # an account that no longer exists.
    canceled = 0
    for request in owned_by(SignRequest.objects.all(), user).filter(
            status=SignRequest.Status.SENT):
        request.status = SignRequest.Status.CANCELED
        request.save(update_fields=["status"])
        canceled += 1

    # Collect the keys now; delete them **after** the transaction commits.
    # Storage is not transactional: deleting first means any later failure
    # rolls the rows back and leaves an intact account whose files are gone —
    # which is worse than either outcome on its own.
    keys = [version.storage_key
            for document in documents
            for version in document.versions.all()]
    keys += [signature.storage_key for signature in user.signatures.all()]
    # `exports/{job}/` and `uploads/u/{user}/…` are separate namespaces (§13)
    # that the guest sweep handles explicitly and this path used to leave
    # behind — and once the Job rows cascade away, `exports_purge` can never
    # find them again.
    export_prefixes = [f"exports/{job_id}/" for job_id in
                       user.jobs.values_list("id", flat=True)]
    user_id = str(user.pk)

    # What is kept is what somebody **signed** — an envelope with a sealed
    # artifact. A request that was sent and never finished has no signature in
    # it, so retaining it would keep the sender's address, the recipients'
    # addresses and both sides' IP addresses to prove nothing at all.
    evidence = owned_by(SignRequest.objects.all(), user).exclude(final_key="")
    removed = {
        "documents": documents.count(),
        "blobs": len(keys),
        "sign_requests_canceled": canceled,
        "sign_requests_retained": evidence.count(),
    }

    # Detach first. `source_version` is `PROTECT` — it exists so a live
    # envelope cannot lose what was signed — but the evidence a *closed*
    # envelope carries is the sealed PDF in storage, not the document row, and
    # leaving the reference in place would block the deletion entirely.
    _detach_envelopes(user)
    # Everything that is not evidence goes with the account.
    owned_by(SignRequest.objects.all(), user).filter(final_key="").delete()
    for document in documents:
        document.delete()

    user.delete()
    transaction.on_commit(lambda: _purge_storage(keys, export_prefixes, user_id))
    return removed


def _purge_storage(keys: list[str], export_prefixes: list[str],
                   user_id: str) -> None:
    """After the rows are gone, and only then."""
    from apps.core.assets import purge_principal_assets
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    for key in keys:
        try:
            storage.delete(key)
        except Exception:  # noqa: BLE001 - a missing blob must not stop the rest
            logger.exception("delete_account: blob %s", key)
    for prefix in export_prefixes:
        try:
            storage.delete_prefix(prefix)
        except Exception:  # noqa: BLE001
            logger.warning("delete_account: could not delete %s", prefix)
    try:
        purge_principal_assets("u", user_id)
    except Exception:  # noqa: BLE001
        logger.exception("delete_account: assets for %s", user_id)


def _delete_unsent_drafts(user) -> None:
    """A draft has been sent to nobody, so there is no evidence in it.

    Retaining one would keep a title and every recipient address the person
    typed, with no owner, no document and no sender — a row that serves nobody
    and reads as an envelope in the export's own manifest.
    """
    from apps.core.principals import owned_by
    from apps.esign.models import SignRequest

    owned_by(SignRequest.objects.all(), user).filter(
        status=SignRequest.Status.DRAFT).delete()


def _detach_envelopes(user) -> None:
    """Keep the *signed* record, cut it loose from the account.

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
