"""Server-side text search (phase 1) — returns normalized rects (§8)."""
from __future__ import annotations

import fitz

from ..exceptions import UnsupportedFileError
from ..geometry import apply_matrix_rect, page_rect_to_norm_clamped


def search_text(data: bytes, q: str, pages: list[int] | None = None) -> list[dict]:
    """Return hits [{page, x, y, w, h}] in normalized visual coordinates.

    `page.search_for` answers in the page's **unrotated** space — measured, not
    assumed; `page.rect` is rotation-applied, so on an unrotated page the two
    are indistinguishable and the difference only shows up on a rotated one,
    where the find bar was highlighting empty space. Rects are rotated into
    display space before being normalized (§8).
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
            rot = tuple(page.rotation_matrix)
            for rect in page.search_for(q):
                x0, y0, x1, y1 = apply_matrix_rect(rect.x0, rect.y0, rect.x1,
                                                   rect.y1, rot)
                nr = page_rect_to_norm_clamped(x0, y0, x1, y1, width, height)
                hits.append(
                    {"page": i, "x": nr.x, "y": nr.y, "w": nr.w, "h": nr.h}
                )
        return hits
    finally:
        doc.close()
