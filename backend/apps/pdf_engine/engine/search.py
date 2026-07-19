"""Server-side text search (phase 1) — returns normalized rects (§8)."""
from __future__ import annotations

import fitz

from ..exceptions import UnsupportedFileError
from ..geometry import page_rect_to_norm


def search_text(data: bytes, q: str, pages: list[int] | None = None) -> list[dict]:
    """Return hits [{page, x, y, w, h}] in normalized visual coordinates.

    Rects come straight from PyMuPDF's page.search_for (page coordinate space =
    visual space per §8), normalized against page.rect.
    """
    if not q:
        return []
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise UnsupportedFileError(f"Could not open PDF: {exc}") from exc

    hits: list[dict] = []
    try:
        indices = pages if pages is not None else range(doc.page_count)
        for i in indices:
            if i < 0 or i >= doc.page_count:
                continue
            page = doc[i]
            width, height = page.rect.width, page.rect.height
            for rect in page.search_for(q):
                nr = page_rect_to_norm(rect.x0, rect.y0, rect.x1, rect.y1, width, height)
                hits.append(
                    {"page": i, "x": nr.x, "y": nr.y, "w": nr.w, "h": nr.h}
                )
        return hits
    finally:
        doc.close()
