"""Ingest service — shared by the upload view and seed_dev (phase-01 ingest)."""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta

from django.conf import settings
from django.utils import timezone

from apps.core import limits as L
from apps.core.exceptions import UnsupportedFile, ValidationFailed
from apps.core.principals import is_guest, owner_kwargs
from apps.pdf_engine.engine import validate_pdf
from apps.pdf_engine.engine.validate import repair_pdf
from apps.pdf_engine.exceptions import EngineError
from apps.pdf_engine.storage import get_storage

from .models import Document, Folder


def guest_expiry() -> datetime:
    """Initial TTL for a guest document; the session's own sliding expiry is
    authoritative for purging (§21.4)."""
    return timezone.now() + timedelta(hours=settings.GUEST_TTL_HOURS)


def ingest_pdf(principal, data: bytes, title: str, *, folder: Folder | None = None,
               want_repair: bool = False, enqueue_thumbnails: bool = True) -> Document:
    """Validate → store v1 "Original" → record version → thumbnails. Returns the doc.

    Size cap and storage quota are enforced by the caller (they are HTTP
    concerns). The **page cap is enforced here**: it is the first point where
    the page count is known, and before 2B it was never checked anywhere at all
    despite §17 describing it in the upload chain.
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

    tier_limits = L.for_principal(principal)
    if info["pages"] > tier_limits.max_pages:
        exc = ValidationFailed(
            f"This PDF has {info['pages']} pages; the limit is "
            f"{tier_limits.max_pages}."
            + (" Create a free account to work with larger documents."
               if tier_limits.tier == "guest" else "")
        )
        exc.zen_details = {
            "pages": info["pages"],
            "max_pages": tier_limits.max_pages,
            "tier": tier_limits.tier,
        }
        raise exc

    document = Document.objects.create(
        **owner_kwargs(principal),
        expires_at=guest_expiry() if is_guest(principal) else None,
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
        label="Original", created_by=None if is_guest(principal) else principal, seq=1,
    )
    L.bump_storage(principal, len(data))
    if enqueue_thumbnails and not info["encrypted"]:
        from .tasks import generate_thumbnails_task

        generate_thumbnails_task.delay(str(document.id), 1, min(info["pages"], 20), 240)

    document.refresh_from_db()
    return document
