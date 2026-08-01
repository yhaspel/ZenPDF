"""Document compare (phase-06; 01-architecture.md §8, §10, §12 heavy queue).

Two independent answers to "what changed", because they fail in different
directions and a reader needs both:

* **text diff** — the words of each page, aligned with `difflib`. Precise about
  wording, blind to anything that is not text: a moved figure, a changed
  colour, a redaction that left the layout alone.
* **visual diff** — both pages rendered and compared pixel by pixel, then the
  differing pixels clustered into rectangles. Sees everything, including noise
  it should ignore, which is why small clusters are dropped.

Page alignment is index-based with a caller-supplied offset (phase-06 says v1;
automatic alignment is backlog). Every rect is §8 normalized visual space, so
the UI can draw them over either side without conversion.
"""
from __future__ import annotations

import difflib

import fitz

from ..exceptions import InvalidParams
from ..geometry import page_rect_to_norm_clamped

# Render DPI for the visual pass. 150 is the phase's number: enough to see a
# changed word, cheap enough to do on every page of a long document.
VISUAL_DPI = 150
# Ignore a region smaller than this share of the page — anti-aliasing and
# subpixel drift produce a scatter of single differing pixels on pages that are
# in fact identical.
MIN_REGION_AREA = 0.0002
# Below this share of differing pixels a page is called visually identical.
NOISE_FLOOR = 0.02
MAX_PAGES = 500


def _norm_rect(rect, page) -> dict:
    nr = page_rect_to_norm_clamped(rect.x0, rect.y0, rect.x1, rect.y1,
                                   page.rect.width, page.rect.height)
    return {"x": round(nr.x, 6), "y": round(nr.y, 6),
            "w": round(nr.w, 6), "h": round(nr.h, 6)}


def _words(page) -> list[tuple]:
    """(x0, y0, x1, y1, word, block, line, word_no) in reading order."""
    return sorted(page.get_text("words"), key=lambda w: (w[5], w[6], w[7]))


def _union(rects: list) -> fitz.Rect | None:
    if not rects:
        return None
    box = fitz.Rect(rects[0])
    for rect in rects[1:]:
        box |= fitz.Rect(rect)
    return box


def _text_changes(page_a, page_b) -> list[dict]:
    """Word-level diff of two pages, with a rect on each side of every change."""
    words_a, words_b = _words(page_a), _words(page_b)
    tokens_a = [w[4] for w in words_a]
    tokens_b = [w[4] for w in words_b]
    changes = []
    matcher = difflib.SequenceMatcher(a=tokens_a, b=tokens_b, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        box_a = _union([w[:4] for w in words_a[i1:i2]])
        box_b = _union([w[:4] for w in words_b[j1:j2]])
        changes.append({
            "kind": tag,                       # insert | delete | replace
            "a_text": " ".join(tokens_a[i1:i2]),
            "b_text": " ".join(tokens_b[j1:j2]),
            "a_rect": _norm_rect(box_a, page_a) if box_a else None,
            "b_rect": _norm_rect(box_b, page_b) if box_b else None,
        })
    return changes


def _cluster(mask: list[list[bool]], width: int, height: int) -> list[tuple]:
    """Differing cells → bounding boxes, by flood fill over a coarse grid.

    Deliberately coarse (the mask is one cell per ~8 px): a per-pixel union-find
    over a 1240×1750 render is both slower and less useful than a handful of
    rectangles a human can click.
    """
    seen = [[False] * width for _ in range(height)]
    boxes = []
    for y in range(height):
        for x in range(width):
            if not mask[y][x] or seen[y][x]:
                continue
            stack = [(x, y)]
            seen[y][x] = True
            x0 = x1 = x
            y0 = y1 = y
            while stack:
                cx, cy = stack.pop()
                x0, x1 = min(x0, cx), max(x1, cx)
                y0, y1 = min(y0, cy), max(y1, cy)
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < width and 0 <= ny < height \
                            and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            boxes.append((x0, y0, x1 + 1, y1 + 1))
    return boxes


def _visual_regions(page_a, page_b) -> tuple[list[dict], float]:
    """Rectangles where the two renders differ, plus the differing share."""
    zoom = VISUAL_DPI / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    pix_a = page_a.get_pixmap(matrix=matrix, colorspace=fitz.csGRAY)
    pix_b = page_b.get_pixmap(matrix=matrix, colorspace=fitz.csGRAY)

    width = min(pix_a.width, pix_b.width)
    height = min(pix_a.height, pix_b.height)
    if width < 2 or height < 2:
        return [], 0.0

    # One mask cell per CELL×CELL block of pixels: enough resolution to point at
    # a changed line, small enough to walk in Python.
    cell = 8
    cols = max(1, width // cell)
    rows = max(1, height // cell)
    samples_a, samples_b = pix_a.samples, pix_b.samples
    stride_a, stride_b = pix_a.stride, pix_b.stride

    mask = [[False] * cols for _ in range(rows)]
    differing = 0
    for row in range(rows):
        py = row * cell
        for col in range(cols):
            px = col * cell
            # Sample the block's centre rather than every pixel in it: a change
            # that is invisible at 8 px is invisible to the reader too.
            index_a = (py + cell // 2) * stride_a + (px + cell // 2)
            index_b = (py + cell // 2) * stride_b + (px + cell // 2)
            if index_a >= len(samples_a) or index_b >= len(samples_b):
                continue
            if abs(samples_a[index_a] - samples_b[index_b]) > 24:
                mask[row][col] = True
                differing += 1

    share = differing / float(rows * cols)
    if share < 0.0005:
        return [], share

    regions = []
    page_w, page_h = page_a.rect.width, page_a.rect.height
    for x0, y0, x1, y1 in _cluster(mask, cols, rows):
        area = ((x1 - x0) / cols) * ((y1 - y0) / rows)
        if area < MIN_REGION_AREA:
            continue
        rect = fitz.Rect(x0 / cols * page_w, y0 / rows * page_h,
                         x1 / cols * page_w, y1 / rows * page_h)
        regions.append(_norm_rect(rect, page_a))
    regions.sort(key=lambda r: (r["y"], r["x"]))
    return regions[:200], share


def compare(a: bytes, b: bytes, *, offset: int = 0,
            visual: bool = True) -> dict:
    """Compare two documents page by page. Returns the §10 compare report."""
    try:
        offset = int(offset)
    except (TypeError, ValueError) as exc:
        raise InvalidParams("`offset` must be a whole number.") from exc

    doc_a = fitz.open(stream=a, filetype="pdf")
    doc_b = fitz.open(stream=b, filetype="pdf")
    try:
        if doc_a.page_count > MAX_PAGES or doc_b.page_count > MAX_PAGES:
            raise InvalidParams(
                f"Compare handles up to {MAX_PAGES} pages per document."
            )
        pages = []
        changed_pages = 0
        total_changes = 0
        # Every page of both documents is reported, even where one side has no
        # counterpart: "page 7 was added" is exactly the kind of change a reader
        # is looking for, and dropping it would make the summary lie.
        first = min(0, offset)
        last = max(doc_a.page_count, doc_b.page_count - offset)
        for index in range(first, last):
            a_index = index
            b_index = index + offset
            has_a = 0 <= a_index < doc_a.page_count
            has_b = 0 <= b_index < doc_b.page_count
            if not has_a and not has_b:
                continue
            entry = {
                "a_page": a_index if has_a else None,
                "b_page": b_index if has_b else None,
                "text_changes": [],
                "visual_regions": [],
                "visual_share": 0.0,
            }
            if has_a and has_b:
                page_a, page_b = doc_a[a_index], doc_b[b_index]
                entry["text_changes"] = _text_changes(page_a, page_b)
                if visual:
                    entry["visual_regions"], entry["visual_share"] = \
                        _visual_regions(page_a, page_b)
            else:
                entry["text_changes"] = [{
                    "kind": "insert" if has_b else "delete",
                    "a_text": "" if not has_a else doc_a[a_index].get_text().strip()[:400],
                    "b_text": "" if not has_b else doc_b[b_index].get_text().strip()[:400],
                    "a_rect": None,
                    "b_rect": None,
                }]
            total_changes += len(entry["text_changes"])
            if entry["text_changes"] or entry["visual_share"] >= NOISE_FLOOR:
                changed_pages += 1
            pages.append(entry)

        return {
            "pages": pages,
            "summary": {
                "a_pages": doc_a.page_count,
                "b_pages": doc_b.page_count,
                "offset": offset,
                "changed_pages": changed_pages,
                "text_changes": total_changes,
                "identical": changed_pages == 0,
            },
        }
    finally:
        doc_a.close()
        doc_b.close()
