"""Page + thumbnail rendering (phase 1). Runs on the `render` queue."""
from __future__ import annotations

import fitz

from ..exceptions import DocumentEncryptedError, PageOutOfRange, UnsupportedFileError


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

    Without its annotations — **with** its form fields. A widget is an
    annotation to the PDF, and MuPDF's own `annots=False` drops those too; but
    the overlay does not draw widgets, so a filled form would come back blank
    under the very tool used to comment on it. The page's markup is removed
    from the in-memory copy instead, and the render keeps everything else.
    """
    doc = _open(data)
    try:
        if doc.needs_pass:
            # A locked document has no pages to draw. Saying so is a 423 the
            # client can act on; letting PyMuPDF raise on `doc[page]` was a 500
            # in every thumbnail strip of a protected document (phase-07).
            raise DocumentEncryptedError(
                "This document is password-protected. Unlock it to see its pages."
            )
        if page < 0 or page >= doc.page_count:
            raise PageOutOfRange(f"page {page} out of range (0..{doc.page_count - 1})")
        p = doc[page]
        if not annots:
            _strip_annotations(p)
        base_w = p.rect.width or 1.0
        zoom = max(width, 1) / base_w
        matrix = fitz.Matrix(zoom, zoom)
        pix = p.get_pixmap(matrix=matrix, alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()


def _strip_annotations(page: fitz.Page) -> None:
    """Delete the page's annotations — not its widgets — from the open copy.

    `first_annot` walks MuPDF's annotation list, which keeps widgets on a list
    of their own (`widgets()`); so this removes exactly the set `annotations.py`
    extracts and the overlay draws, and nothing else. The one-at-a-time loop is
    the documented idiom: deleting invalidates the objects of a pre-built list.
    """
    while page.first_annot is not None:
        page.delete_annot(page.first_annot)


def render_thumbnail(data: bytes, page: int, width: int = 240, *,
                     annots: bool = True) -> bytes:
    """Thumbnail is just a small render; kept separate for intent/caching clarity."""
    return render_page(data, page, width, annots=annots)
