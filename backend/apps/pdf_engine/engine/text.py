"""Text read models (phase-03; extended by phase-04).

`page_words` is the overlay's text layer. The client renders a transparent word
grid over the page image and turns a drag-selection into quads — sourced from
the same PyMuPDF that will apply the resulting annotation, so the coordinates
cannot drift between what the user selected and what gets highlighted.
"""
from __future__ import annotations

import fitz

from ..exceptions import PageOutOfRange, UnsupportedFileError
from ..geometry import page_rect_to_norm


def _open(data: bytes) -> fitz.Document:
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise UnsupportedFileError(f"Could not open PDF: {exc}") from exc
    if doc.needs_pass:
        doc.close()
        from ..exceptions import DocumentEncryptedError

        raise DocumentEncryptedError("Document is encrypted; unlock before editing.")
    return doc


def page_words(data: bytes, page_index: int) -> dict:
    """Every word on one page as a normalized rect, in reading order (§8).

    `block`/`line`/`word` indices come straight from PyMuPDF so the client can
    resolve a drag from word A to word B without re-deriving reading order —
    which is what makes RTL selection behave, since visual order and logical
    order differ there.
    """
    doc = _open(data)
    try:
        if page_index < 0 or page_index >= doc.page_count:
            raise PageOutOfRange(
                f"page {page_index} out of range (0..{doc.page_count - 1})"
            )
        page = doc[page_index]
        pw, ph = page.rect.width, page.rect.height
        words = []
        for i, w in enumerate(page.get_text("words")):
            x0, y0, x1, y1, text, block, line, word = w[:8]
            nr = page_rect_to_norm(x0, y0, x1, y1, pw, ph)
            words.append({
                "i": i,
                "t": text,
                "x": round(nr.x, 6),
                "y": round(nr.y, 6),
                "w": round(nr.w, 6),
                "h": round(nr.h, 6),
                "b": int(block),
                "l": int(line),
                "n": int(word),
            })
        return {
            "width": round(pw, 2),
            "height": round(ph, 2),
            "rotation": page.rotation,
            "has_text": bool(words),
            "words": words,
        }
    finally:
        doc.close()
