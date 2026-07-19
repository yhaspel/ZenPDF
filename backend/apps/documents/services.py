"""Ingest service — shared by the upload view and seed_dev (phase-01 ingest)."""
from __future__ import annotations

import hashlib

from django.contrib.auth import get_user_model
from django.db.models import F

from apps.core.exceptions import UnsupportedFile
from apps.pdf_engine.engine import validate_pdf
from apps.pdf_engine.engine.validate import repair_pdf
from apps.pdf_engine.exceptions import EngineError
from apps.pdf_engine.storage import get_storage

from .models import Document, Folder


def ingest_pdf(user, data: bytes, title: str, *, folder: Folder | None = None,
               want_repair: bool = False, enqueue_thumbnails: bool = True) -> Document:
    """Validate → store v1 "Original" → record version → thumbnails. Returns the doc.

    HTTP concerns (size cap, quota) are enforced by the caller before this runs.
    """
    try:
        info = validate_pdf(data)
    except EngineError as exc:
        raise UnsupportedFile(exc.message) from exc

    if info["needs_repair"]:
        if not want_repair:
            exc = UnsupportedFile("This PDF appears to be damaged.")
            exc.zen_details = {"repair_offer": True}
            raise exc
        try:
            data = repair_pdf(data)
            info = validate_pdf(data)
        except EngineError as exc:
            raise UnsupportedFile(f"Repair failed: {exc.message}") from exc

    document = Document.objects.create(
        owner=user,
        folder=folder,
        title=(title or "Untitled")[:255],
        status=Document.Status.PROCESSING,
        is_encrypted=info["encrypted"],
        metadata=info.get("metadata") or {},
    )
    sha = hashlib.sha256(data).hexdigest()
    key = f"docs/{document.id}/v1.pdf"
    get_storage().put_bytes(key, data)
    document.record_version(
        storage_key=key, size_bytes=len(data), page_count=info["pages"], sha256=sha,
        label="Original", created_by=user, seq=1,
    )
    get_user_model().objects.filter(pk=user.pk).update(
        storage_bytes_used=F("storage_bytes_used") + len(data)
    )
    if enqueue_thumbnails and not info["encrypted"]:
        from .tasks import generate_thumbnails_task

        generate_thumbnails_task.delay(str(document.id), 1, min(info["pages"], 20), 240)

    document.refresh_from_db()
    return document
