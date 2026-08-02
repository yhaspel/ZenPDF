"""Beat tasks owned by core (01-architecture.md §15, §21.4).

`exports_purge` enforces the §15 export TTL, and `guest_purge` runs hourly and
**hard-deletes** expired guest sessions: their
documents, versions, thumbnails and the storage blobs behind all of it. No soft
delete, no trash — for a guest, expiry means gone. That is a feature to
advertise ("no account, files auto-deleted within 24 hours"), and it is what
bounds both anonymous storage cost and breach blast radius.
"""
from __future__ import annotations

import logging

from celery import shared_task
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger("zenpdf")


def _purge_session_exports(session) -> int:
    """`exports/{job_id}/` for every job this guest session owns."""
    from apps.jobs.models import Job
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    removed = 0
    for job_id in Job.objects.filter(guest_session=session).values_list("id", flat=True):
        try:
            removed += storage.delete_prefix(f"exports/{job_id}/")
        except Exception:  # noqa: BLE001
            logger.warning("guest_purge: could not delete exports/%s/", job_id)
    return removed


def _purge_document_blobs(document) -> int:
    """Delete every blob belonging to one document: version PDFs *and*
    thumbnails.

    Thumbnails are keyed `thumbs/{doc}/{seq}/p{n}@{w}.png` — the page/width
    combinations that were actually rendered are not recoverable from the DB, so
    they go by prefix. Deleting only the rows' `storage_key` values would leave
    every thumbnail orphaned in the bucket forever.
    """
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    removed = 0
    for version in document.versions.all():
        try:
            storage.delete(version.storage_key)
            removed += 1
        except Exception:  # noqa: BLE001
            logger.warning("guest_purge: could not delete %s", version.storage_key)
    try:
        removed += storage.delete_prefix(f"docs/{document.id}/")
        removed += storage.delete_prefix(f"thumbs/{document.id}/")
    except Exception:  # noqa: BLE001
        logger.warning("guest_purge: prefix sweep failed for document %s", document.id)
    return removed


@shared_task(name="apps.core.tasks.guest_purge")
def guest_purge() -> dict:
    """Hard-delete expired guest sessions and everything they own."""
    from apps.documents.models import Document

    from .models import GuestSession

    now = timezone.now()
    expired = GuestSession.objects.filter(expires_at__lte=now)
    stats = {"sessions": 0, "documents": 0, "blobs": 0}

    for session in expired:
        # Only rows still pointing at the session are touched. A claimed
        # session's documents were reparented onto the account in the claim
        # transaction, so this can never cascade into rows a user now owns
        # (§21.5) — but scoping the query to `guest_session=session` is what
        # actually guarantees that, not the ordering.
        documents = Document.objects.filter(guest_session=session)
        for document in documents:
            stats["blobs"] += _purge_document_blobs(document)
            # Break the self-reference before the versions go.
            document.current_version = None
            document.save(update_fields=["current_version"])
            document.delete()
            stats["documents"] += 1
        # Ephemeral image assets (custom stamps, watermarks, signatures) live
        # outside the document tree at `uploads/g/{session}/…` (§13), so the
        # document sweep above cannot reach them.
        from .assets import purge_principal_assets

        stats["blobs"] += purge_principal_assets("g", session.id)
        # Export artefacts are keyed by *job*, and the job rows cascade away
        # with the session row below — so they must go first or nothing can
        # find them again. `exports_purge` sweeps by age and would never see
        # them: the rows it iterates are gone. This is what makes "files
        # auto-deleted within 24 hours" true for an export too (§21.4).
        stats["blobs"] += _purge_session_exports(session)
        # Jobs and usage counters cascade from the session row itself.
        session.delete()
        stats["sessions"] += 1

    if stats["sessions"]:
        logger.info(
            "guest_purge: removed %(sessions)s session(s), %(documents)s document(s), "
            "%(blobs)s blob(s)", stats,
        )
    return stats


@shared_task(name="apps.core.tasks.exports_purge")
def exports_purge() -> dict:
    """Delete export artefacts older than the §15 TTL (24 h).

    Exports are the one namespace with no row pointing at it: `convert_to`
    writes `exports/{job_id}/{filename}` and the Job's `result` remembers the
    key, but nothing ever deletes it. Without this the bucket grows for ever —
    and the storage is charged against the principal's quota, so a user who
    exported a large document once would carry that cost permanently.

    The UI says "kept for 24 hours, then deleted" on two screens. This is the
    task that makes that true rather than a claim.
    """
    from datetime import timedelta

    from apps.core import limits as L
    from apps.jobs.models import Job
    from apps.pdf_engine.storage import get_storage

    cutoff = timezone.now() - timedelta(hours=settings.EXPORT_TTL_HOURS)
    storage = get_storage()
    stats = {"jobs": 0, "blobs": 0, "bytes": 0}

    stale = Job.objects.filter(
        type="convert_to", finished_at__lt=cutoff, result__has_key="export",
    )
    for job in stale.iterator():
        export = (job.result or {}).get("export") or {}
        key = export.get("storage_key")
        if not key:
            continue
        try:
            removed = storage.delete_prefix(f"exports/{job.id}/")
        except Exception:  # noqa: BLE001
            logger.warning("exports_purge: could not delete exports/%s/", job.id)
            continue
        if not removed:
            continue
        # Give the quota back — `_save_export` charged it on the way in.
        L.bump_storage(job.principal, -int(export.get("size_bytes") or 0))
        stats["blobs"] += removed
        stats["bytes"] += int(export.get("size_bytes") or 0)
        stats["jobs"] += 1
        # The artefact is gone; the job must stop advertising a download.
        job.result = {k: v for k, v in (job.result or {}).items() if k != "export"}
        job.save(update_fields=["result"])

    if stats["jobs"]:
        logger.info("exports_purge: removed %(blobs)s blob(s) from %(jobs)s job(s)", stats)
    return stats
