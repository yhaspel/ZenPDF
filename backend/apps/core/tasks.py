"""Beat tasks owned by core (01-architecture.md §15, §21.4).

`guest_purge` runs hourly and **hard-deletes** expired guest sessions: their
documents, versions, thumbnails and the storage blobs behind all of it. No soft
delete, no trash — for a guest, expiry means gone. That is a feature to
advertise ("no account, files auto-deleted within 24 hours"), and it is what
bounds both anonymous storage cost and breach blast radius.
"""
from __future__ import annotations

import logging

from celery import shared_task
from django.utils import timezone

logger = logging.getLogger("zenpdf")


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
        # Jobs and usage counters cascade from the session row itself.
        session.delete()
        stats["sessions"] += 1

    if stats["sessions"]:
        logger.info(
            "guest_purge: removed %(sessions)s session(s), %(documents)s document(s), "
            "%(blobs)s blob(s)", stats,
        )
    return stats
