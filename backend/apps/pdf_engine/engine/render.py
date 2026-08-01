"""Page + thumbnail rendering (phase 1). Runs on the `render` queue."""
from __future__ import annotations

import fitz

from ..exceptions import PageOutOfRange, UnsupportedFileError


def _open(data: bytes) -> fitz.Document:
    try:
        return fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise UnsupportedFileError(f"Could not open PDF: {exc}") from exc


def render_page(data: bytes, page: int, width: int = 1024, *, annots: bool = True) -> bytes:
    """Render one page to PNG at the requested pixel width (aspect preserved).

    `annots=False` renders the page *without* its annotations. The annotation
    overlay (phase 3) needs that: it draws every annotation itself as editable
    SVG, so a raster that already contains them would show each one twice — and
    the baked-in copy would not move when the user drags the editable one.
    """
    doc = _open(data)
    try:
        if page < 0 or page >= doc.page_count:
            raise PageOutOfRange(f"page {page} out of range (0..{doc.page_count - 1})")
        p = doc[page]
        base_w = p.rect.width or 1.0
        zoom = max(width, 1) / base_w
        matrix = fitz.Matrix(zoom, zoom)
        pix = p.get_pixmap(matrix=matrix, alpha=False, annots=annots)
        return pix.tobytes("png")
    finally:
        doc.close()


def render_thumbnail(data: bytes, page: int, width: int = 240, *,
                     annots: bool = True) -> bytes:
    """Thumbnail is just a small render; kept separate for intent/caching clarity."""
    return render_page(data, page, width, annots=annots)
