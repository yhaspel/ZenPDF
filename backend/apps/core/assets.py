"""Ephemeral image assets uploaded by a principal (01-architecture.md §13).

Some operations take an *image* the user supplied rather than a PDF: custom
stamps (phase 3), inserted/replaced images and image watermarks (phase 4),
signature images (phase 8). They are not documents — there is no version
history, no library entry, no page count — so they get their own key namespace:

    uploads/{g|u}/{principal_id}/{ref}.png

Two properties matter and are load-bearing:

* **The ref cannot escape its principal's prefix.** A ref is an opaque token and
  the key is *derived* from the caller's principal, never sent by the client, so
  no principal can name another's asset (`^[A-Za-z0-9_-]{6,64}$`, no separators).
* **Guest assets die with the session.** `guest_purge` sweeps the prefix, the
  same way it sweeps documents and thumbnails (§21.4).
"""
from __future__ import annotations

import re
import secrets

from .principals import is_guest

REF_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")

# The per-file byte cap is tier-resolved (`Limits.max_image_upload_bytes`, §16) —
# never hardcoded here. This is only a decompression-bomb ceiling on the decoded
# pixel count, which no tier should ever want to raise.
MAX_IMAGE_PIXELS = 40_000_000  # ~40 MP

_MAGIC = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
}


class ImageRejected(ValueError):
    """The uploaded bytes are not an image we will accept."""


def principal_prefix(principal) -> str:
    """`uploads/{g|u}/{id}/` for this principal."""
    if principal is None:
        raise ValueError("asset storage requires a principal")
    return f"uploads/{'g' if is_guest(principal) else 'u'}/{principal.pk}/"


def asset_key(principal, ref: str) -> str:
    if not REF_RE.match(ref or ""):
        raise ImageRejected(f"invalid image ref {ref!r}")
    return f"{principal_prefix(principal)}{ref}.png"


def sniff(data: bytes) -> str | None:
    for magic, content_type in _MAGIC.items():
        if data.startswith(magic):
            return content_type
    return None


def normalize_png(data: bytes, *, max_bytes: int) -> tuple[bytes, int, int]:
    """Decode → re-encode as PNG. Returns (png_bytes, width, height).

    Normalizing means the engine only ever handles one format, and re-encoding
    drops EXIF (which can carry GPS coordinates the user did not intend to paste
    into a document they are about to share).
    """
    import fitz

    if len(data) > max_bytes:
        raise ImageRejected(
            f"Images must be {max_bytes // (1024 * 1024)} MB or smaller."
        )
    if sniff(data) is None:
        raise ImageRejected("Only PNG and JPEG images are supported.")
    try:
        pix = fitz.Pixmap(data)
    except Exception as exc:  # noqa: BLE001
        raise ImageRejected("That image could not be read.") from exc
    try:
        if pix.width * pix.height > MAX_IMAGE_PIXELS:
            raise ImageRejected("That image is too large to process.")
        # CMYK has no PNG representation; convert through RGB.
        if pix.colorspace is not None and pix.colorspace.n == 4:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        return pix.tobytes("png"), pix.width, pix.height
    finally:
        pix = None


def store_image(principal, data: bytes) -> dict:
    """Validate, normalize and store. Returns the wire shape for the API."""
    from apps.pdf_engine.storage import get_storage

    from . import limits as L

    png, width, height = normalize_png(
        data, max_bytes=L.for_principal(principal).max_image_upload_bytes
    )
    ref = secrets.token_urlsafe(18).replace("=", "")[:32]
    get_storage().put_bytes(asset_key(principal, ref), png, content_type="image/png")
    return {"ref": ref, "width": width, "height": height, "content_type": "image/png"}


def load_images(principal, refs) -> dict[str, bytes]:
    """Fetch `refs` for this principal. Unknown refs are simply absent, so the
    engine raises a validation error naming the ref instead of a 500."""
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    out: dict[str, bytes] = {}
    for ref in {r for r in refs if r}:
        if not REF_RE.match(str(ref)):
            continue
        key = asset_key(principal, str(ref))
        try:
            out[str(ref)] = storage.get_bytes(key)
        except Exception:  # noqa: BLE001
            continue
    return out


def purge_principal_assets(principal_kind: str, principal_id) -> int:
    """Delete every asset of one principal. Used by `guest_purge` (§21.4)."""
    from apps.pdf_engine.storage import get_storage

    prefix = f"uploads/{principal_kind}/{principal_id}/"
    try:
        return get_storage().delete_prefix(prefix)
    except Exception:  # noqa: BLE001
        return 0
