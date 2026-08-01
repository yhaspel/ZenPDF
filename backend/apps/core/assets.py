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


def header_dimensions(data: bytes) -> tuple[int, int] | None:
    """(width, height) read from the file header, WITHOUT decoding the image.

    This is the whole defence against a decompression bomb: a 1.5 MB PNG of
    zeros decodes to 40000×40000 = 1.6 Gpx ≈ 2.9 GB, which is inside every byte
    cap we have and is allocated *in the API process*, where none of §12's worker
    memory limits apply. Checking the pixel count after `fitz.Pixmap(data)` is
    checking after the damage: on Linux the OOM killer takes the worker, so there
    is not even an exception to catch.

    Returns None when the header cannot be parsed; the caller then refuses.
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        # IHDR is the mandatory first chunk: 8-byte signature, 4-byte length,
        # 4-byte type, then width and height as big-endian uint32.
        if len(data) < 24 or data[12:16] != b"IHDR":
            return None
        return (int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big"))

    if data.startswith(b"\xff\xd8\xff"):
        # Walk the marker segments to the first SOFn, which carries the size.
        i = 2
        n = len(data)
        while i + 3 < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            if i + 4 > n:
                return None
            length = int.from_bytes(data[i + 2:i + 4], "big")
            # SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                if i + 9 > n:
                    return None
                return (
                    int.from_bytes(data[i + 7:i + 9], "big"),
                    int.from_bytes(data[i + 5:i + 7], "big"),
                )
            if length < 2:
                return None
            i += 2 + length
        return None

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

    # Refuse on the *header* — before any allocation. See `header_dimensions`.
    dims = header_dimensions(data)
    if dims is None:
        raise ImageRejected("That image could not be read.")
    width, height = dims
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise ImageRejected("That image is too large to process.")

    try:
        pix = fitz.Pixmap(data)
    except Exception as exc:  # noqa: BLE001
        raise ImageRejected("That image could not be read.") from exc
    try:
        # The header could still be lying; re-check what actually decoded.
        if pix.width * pix.height > MAX_IMAGE_PIXELS:
            raise ImageRejected("That image is too large to process.")
        # CMYK has no PNG representation; convert through RGB.
        if pix.colorspace is not None and pix.colorspace.n == 4:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        return pix.tobytes("png"), pix.width, pix.height
    finally:
        pix = None


class AssetQuotaExceeded(ValueError):
    """Storing this asset would push the principal over its storage quota."""

    def __init__(self, message: str, *, quota: int, used: int):
        super().__init__(message)
        self.quota = quota
        self.used = used


def store_image(principal, data: bytes) -> dict:
    """Validate, normalize, meter and store. Returns the wire shape for the API.

    The stored object is metered against the principal's storage quota like
    every other write. It is not optional bookkeeping: normalization re-encodes
    to *lossless* PNG, which measured 3–5× larger than the JPEG that came in, so
    an unmetered namespace would let a ≤5 MB upload become ~120 MB of storage
    that no quota, usage panel or purge ever saw.
    """
    from apps.pdf_engine.storage import get_storage

    from . import limits as L

    tier = L.for_principal(principal)
    png, width, height = normalize_png(data, max_bytes=tier.max_image_upload_bytes)

    used = L.storage_used(principal)
    if used + len(png) > tier.storage_bytes:
        raise AssetQuotaExceeded(
            "Storing this image would exceed your storage quota.",
            quota=tier.storage_bytes, used=used,
        )

    ref = secrets.token_urlsafe(18).replace("=", "")[:32]
    get_storage().put_bytes(asset_key(principal, ref), png, content_type="image/png")
    L.bump_storage(principal, len(png))
    return {"ref": ref, "width": width, "height": height, "content_type": "image/png"}


def move_assets(from_kind: str, from_id, to_principal) -> int:
    """Re-key one principal's assets onto another. Used by claim-on-signup.

    `uploads/…` is the one namespace whose key contains the *principal*, which
    breaks the §13 property claim relies on ("blob keys are principal-independent,
    so claiming is a metadata-only reparent"). Without this, registering would
    orphan a guest's stamps under a prefix `guest_purge` deletes within the hour —
    losing them exactly at the moment the funnel is selling persistence.
    """
    from apps.pdf_engine.storage import get_storage

    storage = get_storage()
    source = f"uploads/{from_kind}/{from_id}/"
    target = principal_prefix(to_principal)
    moved = 0
    for key in storage.list_prefix(source):
        try:
            storage.put_bytes(
                f"{target}{key[len(source):]}",
                storage.get_bytes(key),
                content_type="image/png",
            )
            storage.delete(key)
            moved += 1
        except Exception:  # noqa: BLE001
            continue
    return moved


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
