"""Content editing engine (phase-04; 01-architecture.md §8, §10).

The differentiator cluster: editing text that is already in the file, adding
text and images, links, whiteout, find & replace, and the stamping suite
(watermark, header/footer, page numbers, Bates, overlay) plus metadata and
bookmarks.

**Text editing is block-scoped and honest about it.** There is no reflow engine
here: a block is redacted away and its replacement is drawn back into the same
box (`add_redact_annot` → `apply_redactions` → `insert_htmlbox`). That is why
the UI documents the constraints it does — no cross-block reflow, and a
replacement font that approximates the original when the embedded one is a
subset (which it usually is).

Geometry crosses this boundary normalized (§8) and is de-rotated exactly as in
`annotations.py`: `page.rect` is rotation-applied, everything PyMuPDF *writes*
is not.
"""
from __future__ import annotations

import html
from datetime import UTC

import fitz

from ..colors import css_color, parse_color
from ..exceptions import EngineError, InvalidParams, PageOutOfRange, UnsupportedFileError
from ..geometry import (
    NormRect,
    apply_matrix_point,
    apply_matrix_rect,
    norm_to_page_rect,
)

_SAVE = dict(garbage=4, deflate=True, deflate_images=True, deflate_fonts=True)

# `insert_htmlbox` shrinks to fit when given room to. phase-04 fixes the floor
# at 65% of the requested size: below that the replacement stops looking like
# the document and the user should be told, not silently given 6pt text.
MIN_SHRINK = 0.65

# Only these reach a CSS `font-family`. An arbitrary string would be injected
# into a stylesheet, and PyMuPDF would fall back anyway.
FONT_FAMILIES = {
    "helvetica": "sans-serif",
    "sans-serif": "sans-serif",
    "times": "serif",
    "serif": "serif",
    "courier": "monospace",
    "monospace": "monospace",
}

POSITIONS = (
    "top-left", "top-center", "top-right",
    "bottom-left", "bottom-center", "bottom-right",
)


class TextOverflow(EngineError):
    """Replacement text does not fit its box even at the minimum size."""

    code = "text_overflow"


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


def _page(doc: fitz.Document, index) -> fitz.Page:
    try:
        i = int(index)
    except (TypeError, ValueError) as exc:
        raise InvalidParams(f"invalid page {index!r}") from exc
    if i < 0 or i >= doc.page_count:
        raise PageOutOfRange(f"page {i} out of range (0..{doc.page_count - 1})")
    return doc[i]


def _norm(value, what: str) -> NormRect:
    try:
        return NormRect.from_dict(value)
    except ValueError as exc:
        raise InvalidParams(f"invalid {what}: {exc}") from exc


def _display_rect(value, page: fitz.Page, what: str = "rect") -> fitz.Rect:
    """Normalized → **display** space, i.e. `page.rect` (§8).

    For `insert_htmlbox`, which is the one PyMuPDF writer that applies the page
    rotation itself. Measured, because the family is not consistent — see
    `_raw_rect`.
    """
    x0, y0, x1, y1 = norm_to_page_rect(_norm(value, what), page.rect.width, page.rect.height)
    return fitz.Rect(x0, y0, x1, y1)


def _raw_rect(value, page: fitz.Page, what: str = "rect") -> fitz.Rect:
    """Normalized → the page's **unrotated** space (§8).

    For `draw_rect`, `insert_image`, `add_redact_annot` and `insert_link`, none
    of which apply the page rotation. On a /Rotate 90 page the difference is a
    quarter turn, so mixing the two puts content on the wrong side of the page.
    """
    return fitz.Rect(*_derotate(_display_rect(value, page, what), page))


def _derotate(rect: fitz.Rect, page: fitz.Page) -> tuple[float, float, float, float]:
    return apply_matrix_rect(rect.x0, rect.y0, rect.x1, rect.y1,
                             tuple(page.derotation_matrix))


def _resolve_pages(doc: fitz.Document, spec: dict | None) -> list[int]:
    """`{pages?: [...], skip_first?: bool}` → concrete indices, in order."""
    spec = spec or {}
    pages = spec.get("pages")
    if pages is None:
        indices = list(range(doc.page_count))
    else:
        indices = []
        for p in pages:
            i = int(p)
            if i < 0 or i >= doc.page_count:
                raise PageOutOfRange(f"page {i} out of range (0..{doc.page_count - 1})")
            indices.append(i)
        indices = sorted(set(indices))
    if spec.get("skip_first") and indices:
        # The first page *of the selection*. Dropping index 0 unconditionally
        # made the flag a silent no-op whenever an explicit range was given.
        indices = indices[1:]
    if not indices:
        raise InvalidParams("the selected page range is empty")
    return indices


def _style_css(style: dict | None, *, default_size: float = 11.0) -> str:
    style = style or {}
    size = float(style.get("size") or default_size)
    if not 4 <= size <= 200:
        raise InvalidParams("font size must be between 4 and 200")
    family = FONT_FAMILIES.get(str(style.get("font_family") or "helvetica").lower())
    if family is None:
        raise InvalidParams(
            f"unsupported font family {style.get('font_family')!r}; "
            f"one of {sorted(set(FONT_FAMILIES))}"
        )
    align = str(style.get("align") or "left")
    if align not in {"left", "center", "right", "justify"}:
        raise InvalidParams("align must be left, center, right or justify")
    weight = "font-weight:bold;" if style.get("bold") else ""
    italic = "font-style:italic;" if style.get("italic") else ""
    return (
        f"font-family:{family};font-size:{size}px;"
        f"color:{css_color(style.get('color'))};text-align:{align};"
        f"{weight}{italic}"
    )


def _html_block(text: str, style: dict | None, *, default_size: float = 11.0) -> str:
    """User text as HTML. Escaped, and newlines become breaks so a multi-line
    edit stays multi-line instead of collapsing into a paragraph."""
    escaped = html.escape(str(text or "")).replace("\n", "<br>")
    return f"<div style=\"{_style_css(style, default_size=default_size)}\">{escaped}</div>"


def _write_box(page: fitz.Page, raw_rect: fitz.Rect, text: str, style: dict | None,
               *, default_size: float = 11.0, overlay: bool = True,
               opacity: float = 1.0) -> None:
    """Draw text into `raw_rect`, shrinking to `MIN_SHRINK` before giving up.

    `raw_rect` is in the page's **unrotated** space, and the page's rotation is
    temporarily zeroed around the write. That is not a trick — it is the correct
    model for replacing text: the glyphs being replaced were themselves laid
    down in unrotated space, so the replacement must be too, and it then rotates
    with the page exactly as the original did.

    Passing a *display* rect instead (with `insert_htmlbox`'s own rotation
    handling) fails on any /Rotate 90 page: the display box of a normal line of
    text is tall and narrow, horizontal layout cannot fit it, and every edit
    came back as `text_overflow` telling the user their text was too long.

    `insert_htmlbox` returns `(spare_height, scale)`; a **negative** spare height
    means it could not fit even at `scale_low`. Asking a second time with no
    floor tells us the size that *would* work, which is what the UI needs to
    offer "shrink to N pt / enlarge the box / cancel" (phase-04 error contract).
    """
    size = float((style or {}).get("size") or default_size)
    html = _html_block(text, style, default_size=default_size)
    rotation = page.rotation
    if rotation:
        page.set_rotation(0)
    try:
        spare, _ = page.insert_htmlbox(
            raw_rect, html, scale_low=MIN_SHRINK, overlay=overlay, opacity=opacity,
        )
        if spare >= 0:
            return
        _, unbounded = page.insert_htmlbox(
            raw_rect, html, scale_low=0, overlay=overlay, opacity=opacity,
        )
    finally:
        if rotation:
            page.set_rotation(rotation)
    fits_at = round(size * float(unbounded or 0), 1)
    raise TextOverflow(
        "That text does not fit the box at this size.",
        details={"fits_at_size": fits_at, "requested_size": size,
                 "min_scale": MIN_SHRINK},
    )


# --------------------------------------------------------------------------- #
# Read models
# --------------------------------------------------------------------------- #
def text_blocks(data: bytes, page_index: int) -> dict:
    """Editable blocks for one page (phase-04 "Read model").

    `is_scanned_page` is what the editor gates on: a page with no extractable
    text and a full-page image is a picture of text, and pretending otherwise
    would let the user "edit" a block that is not there.
    """
    from ..colors import from_int

    doc = _open(data)
    try:
        page = _page(doc, page_index)
        pw, ph = page.rect.width, page.rect.height
        rot = tuple(page.rotation_matrix)
        raw = page.get_text("dict")
        blocks = []
        for block in raw.get("blocks", []):
            if block.get("type") != 0:
                continue
            lines = []
            text_parts = []
            for line in block.get("lines", []):
                spans = []
                for span in line.get("spans", []):
                    x0, y0, x1, y1 = apply_matrix_rect(*span["bbox"], rot)
                    nr = _rect_dict(x0, y0, x1, y1, pw, ph)
                    flags = int(span.get("flags", 0))
                    spans.append({
                        "text": span.get("text", ""),
                        "font": span.get("font", ""),
                        "size": round(float(span.get("size", 0)), 2),
                        "color": from_int(span.get("color", 0)),
                        # PyMuPDF packs style into a bitfield: bit 4 = bold,
                        # bit 1 = italic.
                        "bold": bool(flags & 16),
                        "italic": bool(flags & 2),
                        "bbox": nr,
                    })
                    text_parts.append(span.get("text", ""))
                lx0, ly0, lx1, ly1 = apply_matrix_rect(*line["bbox"], rot)
                lines.append({"bbox": _rect_dict(lx0, ly0, lx1, ly1, pw, ph), "spans": spans})
                text_parts.append("\n")
            bx0, by0, bx1, by1 = apply_matrix_rect(*block["bbox"], rot)
            blocks.append({
                "block_id": int(block.get("number", len(blocks))),
                "bbox": _rect_dict(bx0, by0, bx1, by1, pw, ph),
                "lines": lines,
                "text": "".join(text_parts).strip("\n"),
            })

        # `get_image_info` reports placements from the content stream.
        # `get_image_rects` would decode every embedded image to MD5-match it —
        # a 20000x20000 image is 1.2 GB of allocation, in the API process, where
        # §12's worker memory limits do not apply.
        full_page_image = any(
            _covers_page(page, fitz.Rect(info["bbox"]))
            for info in page.get_image_info()
        )
        return {
            "page": page_index,
            "width": round(pw, 2),
            "height": round(ph, 2),
            "rotation": page.rotation,
            # A scan is "no text worth editing" *and* a picture covering the
            # page — either alone is a blank page or a photo with a caption.
            "is_scanned_page": not blocks and full_page_image,
            "blocks": blocks,
        }
    finally:
        doc.close()


def _rect_dict(x0, y0, x1, y1, pw, ph) -> dict:
    """Normalized rect for a **read model** — clamped, never raising.

    Content legitimately sits outside the visible page in real files (CropBox
    insets for trim marks, full-bleed images). Reporting that as a hard error
    made every one of these endpoints answer 500 for an ordinary print PDF.
    """
    from ..geometry import page_rect_to_norm_clamped

    nr = page_rect_to_norm_clamped(x0, y0, x1, y1, pw, ph)
    return {"x": round(nr.x, 6), "y": round(nr.y, 6),
            "w": round(nr.w, 6), "h": round(nr.h, 6)}


def _covers_page(page: fitz.Page, rect) -> bool:
    area = page.rect.get_area()
    return bool(area) and rect.get_area() / area > 0.8


def page_images(data: bytes, page_index: int) -> dict:
    doc = _open(data)
    try:
        page = _page(doc, page_index)
        pw, ph = page.rect.width, page.rect.height
        rot = tuple(page.rotation_matrix)
        out = []
        # One entry per *placement*, straight from the content stream. The
        # previous `get_images` × `get_image_rects` pairing both decoded every
        # image (see `text_blocks`) and matched placements by pixel MD5, so N
        # xrefs sharing content produced N² entries — which a merged document
        # produces naturally.
        for info in page.get_image_info(xrefs=True):
            bbox = fitz.Rect(info["bbox"])
            x0, y0, x1, y1 = apply_matrix_rect(bbox.x0, bbox.y0, bbox.x1, bbox.y1, rot)
            out.append({
                "xref": int(info.get("xref") or 0),
                "width": int(info.get("width") or 0),
                "height": int(info.get("height") or 0),
                "bbox": _rect_dict(x0, y0, x1, y1, pw, ph),
            })
        return {"page": page_index, "images": out}
    finally:
        doc.close()


def page_links(data: bytes, page_index: int) -> dict:
    doc = _open(data)
    try:
        page = _page(doc, page_index)
        pw, ph = page.rect.width, page.rect.height
        rot = tuple(page.rotation_matrix)
        out = []
        for i, link in enumerate(page.get_links()):
            rect = link.get("from")
            if rect is None:
                continue
            x0, y0, x1, y1 = apply_matrix_rect(rect.x0, rect.y0, rect.x1, rect.y1, rot)
            item = {"index": i, "bbox": _rect_dict(x0, y0, x1, y1, pw, ph)}
            if link.get("kind") == fitz.LINK_URI:
                item["kind"] = "uri"
                item["uri"] = link.get("uri", "")
            elif link.get("kind") == fitz.LINK_GOTO:
                item["kind"] = "page"
                item["page"] = int(link.get("page", 0))
            else:
                item["kind"] = "other"
            out.append(item)
        return {"page": page_index, "links": out}
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Text
# --------------------------------------------------------------------------- #
def edit_text(data: bytes, *, edits: list[dict]) -> bytes:
    """Replace the text of one or more blocks (phase-04 "Engine algorithm").

    Redact first (removing glyphs only — `PDF_REDACT_IMAGE_NONE`, so a figure
    behind the text is untouched), then re-insert. All redactions for a page are
    applied in one pass: `apply_redactions` rewrites the content stream, and
    doing it per-edit would invalidate the bboxes of the edits still queued.
    """
    if not edits:
        raise InvalidParams("`edits` must be a non-empty list.")
    doc = _open(data)
    try:
        by_page: dict[int, list[dict]] = {}
        for edit in edits:
            by_page.setdefault(int(edit.get("page", 0)), []).append(edit)

        for page_index, page_edits in by_page.items():
            page = _page(doc, page_index)
            rects = []
            for edit in page_edits:
                # Redaction is an annotation (unrotated); the replacement goes
                # back through insert_htmlbox (display). Two spaces, one edit.
                raw = _raw_rect(edit.get("block_bbox"), page, "block_bbox")
                # A hairline of padding: glyph ink routinely overhangs the
                # reported bbox, and a leftover sliver reads as a rendering bug.
                page.add_redact_annot(
                    fitz.Rect(raw.x0 - 1, raw.y0 - 1, raw.x1 + 1, raw.y1 + 1)
                )
                rects.append((raw, edit))
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
            for rect, edit in rects:
                style = edit.get("style") or {}
                # `rotate` matters on a rotated page: the block's display box is
                # tall and narrow (the text reads vertically to the viewer), and
                # laying the replacement out horizontally into it overflows —
                # so every edit on a landscape-rotated page failed with
                # `text_overflow` telling the user their text was too long.
                _write_box(page, rect, edit.get("new_text", ""), style,
                           default_size=float(style.get("size") or 11))
        _subset(doc)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def _subset(doc: fitz.Document) -> None:
    """Font subsetting keeps an edited file from ballooning; never fatal."""
    try:
        doc.subset_fonts()
    except Exception:  # noqa: BLE001
        pass


def add_text(data: bytes, *, boxes: list[dict]) -> bytes:
    if not boxes:
        raise InvalidParams("`boxes` must be a non-empty list.")
    doc = _open(data)
    try:
        for box in boxes:
            page = _page(doc, box.get("page", 0))
            style = box.get("style") or {}
            _write_box(page, _raw_rect(box.get("rect"), page), box.get("text", ""),
                       style, default_size=float(style.get("size") or 12))
        _subset(doc)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def whiteout(data: bytes, *, rects: list[dict], color=None) -> bytes:
    """Paint filled rectangles over content.

    **Not redaction.** The text underneath is still in the file and still
    extractable — that is documented in the UI copy, because a user who believes
    otherwise is one copy-paste away from a leak. `redact` (phase 7) is the tool
    that removes content.
    """
    if not rects:
        raise InvalidParams("`rects` must be a non-empty list.")
    fill = parse_color(color) if color is not None else (1.0, 1.0, 1.0)
    doc = _open(data)
    try:
        for item in rects:
            page = _page(doc, item.get("page", 0))
            page.draw_rect(_raw_rect(item.get("rect"), page), color=None, fill=fill,
                           width=0, overlay=True)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def find_replace(data: bytes, *, find: str, replace: str = "", match_case: bool = False,
                 pages: list[int] | None = None, dry_run: bool = False,
                 only: list[str] | None = None) -> tuple[bytes | None, dict]:
    """Two-step find & replace (phase-04).

    `dry_run` returns the matches with stable ids and enough context to review;
    the second call passes `only` with the ids the user kept. Ids are
    `p{page}:{ordinal}` — positional, and stable for as long as the document is
    not edited underneath the review, which is exactly the window the flow uses.
    """
    if not find:
        raise InvalidParams("`find` must not be empty.")
    doc = _open(data)
    try:
        indices = pages if pages is not None else range(doc.page_count)
        keep = set(only) if only is not None else None
        matches: list[dict] = []
        applied = 0

        for page_index in indices:
            if page_index < 0 or page_index >= doc.page_count:
                continue
            page = doc[page_index]
            pw, ph = page.rect.width, page.rect.height
            rot = tuple(page.rotation_matrix)
            # `search_for` answers in the page's **unrotated** space, exactly
            # like `get_text` — measured, because the opposite is easy to assume
            # (`page.rect` is rotation-applied, and an unrotated page makes the
            # two indistinguishable). Everything below stays in that space, and
            # only the two places that need display space convert.
            hits = _search(page, find, match_case)
            targets = []
            for ordinal, rect in enumerate(hits):
                match_id = f"p{page_index}:{ordinal}"
                dx0, dy0, dx1, dy1 = apply_matrix_rect(rect.x0, rect.y0,
                                                       rect.x1, rect.y1, rot)
                matches.append({
                    "id": match_id,
                    "page": page_index,
                    "rect": _rect_dict(dx0, dy0, dx1, dy1, pw, ph),
                    "context": _context_around(page, rect),
                })
                if keep is None or match_id in keep:
                    targets.append(rect)

            if dry_run or not targets:
                continue
            # Read the span style before the redaction removes the span.
            styles = [_span_style_at(page, rect) for rect in targets]
            for rect in targets:
                page.add_redact_annot(fitz.Rect(rect.x0 - 0.5, rect.y0 - 0.5,
                                                rect.x1 + 0.5, rect.y1 + 0.5))
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
            for rect, style in zip(targets, styles):
                if replace:
                    size = float(style.get("size") or 11)
                    # Already unrotated — `search_for` and `_write_box` agree.
                    _write_box(page, _replacement_box(page, rect, replace, size),
                               replace, style, default_size=size)
                applied += 1

        result = {"query": find, "count": len(matches), "matches": matches,
                  "replaced": applied, "dry_run": bool(dry_run)}
        if dry_run:
            return None, result
        _subset(doc)
        return doc.tobytes(**_SAVE), result
    finally:
        doc.close()


# Typographic ligatures a PDF renderer substitutes for the plain letters. Real
# documents are full of them (any LaTeX or InDesign output), and `search_for`
# matches glyphs, not intent — so "different" finds nothing in a file that
# stores "di<ff>erent". Searching the variants too is what makes find & replace
# work on documents we did not create, including our own edited output.
LIGATURES = (("ffi", "\ufb03"), ("ffl", "\ufb04"), ("ff", "\ufb00"),
             ("fi", "\ufb01"), ("fl", "\ufb02"))


def ligature_variants(needle: str) -> list[str]:
    """`needle` plus its ligature spellings, longest substitutions first."""
    variants = [needle]
    folded = needle
    for plain, ligature in LIGATURES:
        folded = folded.replace(plain, ligature)
    if folded != needle:
        variants.append(folded)
    # Also the individual substitutions, so "offer file" is found when only one
    # of the two was ligated.
    for plain, ligature in LIGATURES:
        single = needle.replace(plain, ligature)
        if single != needle and single not in variants:
            variants.append(single)
    return variants


def _split_merged(page: fitz.Page, rect: fitz.Rect, find: str) -> list[fitz.Rect]:
    """Split a hit that covers several adjacent occurrences.

    `search_for` returns ONE rect for directly-abutting matches — "banana"
    searched for "na" comes back as a single box over both. Redacting that box
    and writing one replacement silently **deletes** the second occurrence, and
    the dry run under-reports the count the user is about to act on.

    The occurrences are the same string, so they are the same width: counting
    them in the text under the rect and dividing evenly recovers them exactly.
    """
    import unicodedata

    inner = unicodedata.normalize("NFKC", page.get_textbox(rect) or "")
    needle = unicodedata.normalize("NFKC", find)
    occurrences = inner.lower().count(needle.lower()) if needle else 0
    if occurrences <= 1:
        return [rect]
    step = rect.width / occurrences
    return [
        fitz.Rect(rect.x0 + i * step, rect.y0, rect.x0 + (i + 1) * step, rect.y1)
        for i in range(occurrences)
    ]


def _search(page: fitz.Page, find: str, match_case: bool) -> list[fitz.Rect]:
    """Hits for `find`, in display space.

    Two things `page.search_for` will not do on its own:
      * **case sensitivity** — it has no such option and is always insensitive,
        so an exact-case search is filtered afterwards against the text actually
        under each hit;
      * **ligatures** — see `ligature_variants`.
    """
    seen: list[fitz.Rect] = []
    for variant in ligature_variants(find):
        for merged in page.search_for(variant):
            for rect in _split_merged(page, merged, variant):
                if any(abs(rect.x0 - r.x0) < 0.5 and abs(rect.y0 - r.y0) < 0.5
                       for r in seen):
                    continue
                if match_case and not _matches_case(page, rect, find):
                    continue
                seen.append(rect)
    seen.sort(key=lambda r: (round(r.y0, 1), r.x0))
    return seen


def _matches_case(page: fitz.Page, rect: fitz.Rect, find: str) -> bool:
    """`search_for` is unconditionally case-insensitive, so an exact-case search
    is filtered against the text actually under the hit. Both are in the page's
    unrotated space, so no transform belongs here."""
    import unicodedata

    found = unicodedata.normalize("NFKC", page.get_textbox(rect) or "")
    return unicodedata.normalize("NFKC", find) in found


def _replacement_box(page: fitz.Page, rect: fitz.Rect, replace: str,
                     size: float) -> fitz.Rect:
    """A box wide enough for the replacement, clamped to the page.

    Sizing off *character count* is not enough: "cat"→"CAT" is the same length
    and measurably wider, and the tight box then failed the whole job with
    `text_overflow`. The width comes from `get_text_length`, and the box is
    clamped so a long replacement near the right margin is drawn on the page
    rather than off the edge of it.
    """
    needed = fitz.get_text_length(replace, fontname="helv", fontsize=size) * 1.08
    width = max(rect.width, needed)
    box = fitz.Rect(rect.x0, rect.y0 - 1, rect.x0 + width, rect.y1 + 1)
    limit = page.mediabox
    if box.x1 > limit.x1:
        # Prefer keeping the text on the page over keeping its left edge.
        shift = min(box.x0 - limit.x0, box.x1 - limit.x1)
        box = fitz.Rect(box.x0 - shift, box.y0, min(box.x1 - shift, limit.x1), box.y1)
    return box


def _span_style_at(page: fitz.Page, rect: fitz.Rect) -> dict:
    """The style of the span a match sits in, so the replacement inherits it.

    Both `search_for` and `get_text` answer in the page's unrotated space, so
    the rects compare directly.
    """
    from ..colors import from_int

    best = None
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                sr = fitz.Rect(span["bbox"])
                if sr.intersects(rect):
                    overlap = (sr & rect).get_area()
                    if best is None or overlap > best[0]:
                        best = (overlap, span)
    if best is None:
        return {}
    span = best[1]
    flags = int(span.get("flags", 0))
    return {
        "size": round(float(span.get("size", 11)), 2),
        "color": from_int(span.get("color", 0)),
        "bold": bool(flags & 16),
        "italic": bool(flags & 2),
    }


def _context_around(page: fitz.Page, rect: fitz.Rect) -> str:
    """A snippet of the line the match sits on, for the review list.

    Unrotated space throughout — `rect` comes from `search_for` and the band is
    measured against the mediabox, which is the same space.
    """
    box = page.mediabox
    band = fitz.Rect(box.x0, rect.y0 - 1, box.x1, rect.y1 + 1)
    return (page.get_textbox(band) or "").replace("\n", " ").strip()[:160]


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #
def add_image(data: bytes, *, page: int, rect: dict, image: bytes,
              keep_aspect: bool = True) -> bytes:
    if not image:
        raise InvalidParams("no image was provided")
    doc = _open(data)
    try:
        pg = _page(doc, page)
        pg.insert_image(_raw_rect(rect, pg), stream=image, keep_proportion=keep_aspect)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def replace_image(data: bytes, *, page: int, xref: int, image: bytes) -> bytes:
    if not image:
        raise InvalidParams("no image was provided")
    doc = _open(data)
    try:
        pg = _page(doc, page)
        if xref not in {i[0] for i in pg.get_images(full=True)}:
            raise InvalidParams(f"image {xref} is not on page {page}")
        pg.replace_image(xref, stream=image)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def delete_image(data: bytes, *, page: int, xref: int) -> bytes:
    """Remove an image, leaving the text around it alone.

    `PDF_REDACT_IMAGE_REMOVE` with `text=PDF_REDACT_TEXT_NONE`: the redaction
    machinery is the only thing that can excise image content, but its default
    would also delete every glyph inside the picture's box.
    """
    doc = _open(data)
    try:
        pg = _page(doc, page)
        try:
            rects = pg.get_image_rects(xref)
        except Exception as exc:  # noqa: BLE001
            # PyMuPDF raises "bad xref" rather than answering "not here".
            raise InvalidParams(f"image {xref} is not on page {page}") from exc
        if not rects:
            raise InvalidParams(f"image {xref} is not on page {page}")
        for rect in rects:
            pg.add_redact_annot(rect)
        pg.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE,
                            text=fitz.PDF_REDACT_TEXT_NONE)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Links
# --------------------------------------------------------------------------- #
SAFE_LINK_SCHEMES = ("http://", "https://", "mailto:")


def _validate_uri(uri: str) -> str:
    """Only http(s) and mailto reach a PDF link.

    A PDF link is a click target in someone else's reader; `javascript:` and
    `file:` there are an attack on the recipient, not a feature for the author.
    """
    value = str(uri or "").strip()
    if not value.lower().startswith(SAFE_LINK_SCHEMES):
        raise InvalidParams("links must be http(s) or mailto URLs")
    if len(value) > 2000:
        raise InvalidParams("that link is too long")
    return value


def _link_spec(doc: fitz.Document, page: fitz.Page, spec: dict) -> dict:
    rect = _raw_rect(spec.get("rect"), page)
    kind = spec.get("kind", "uri")
    if kind == "uri":
        return {"kind": fitz.LINK_URI, "from": rect, "uri": _validate_uri(spec.get("uri"))}
    if kind == "page":
        target = int(spec.get("page_target", 0))
        if target < 0 or target >= doc.page_count:
            raise PageOutOfRange(f"link target page {target} out of range")
        return {"kind": fitz.LINK_GOTO, "from": rect, "page": target,
                "to": fitz.Point(0, 0)}
    raise InvalidParams("link kind must be 'uri' or 'page'")


def add_link(data: bytes, *, page: int, **spec) -> bytes:
    doc = _open(data)
    try:
        pg = _page(doc, page)
        pg.insert_link(_link_spec(doc, pg, spec))
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def edit_link(data: bytes, *, page: int, index: int, **spec) -> bytes:
    doc = _open(data)
    try:
        pg = _page(doc, page)
        links = pg.get_links()
        if index < 0 or index >= len(links):
            raise InvalidParams(f"link {index} not found on page {page}")
        pg.delete_link(links[index])
        pg.insert_link(_link_spec(doc, pg, spec))
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def delete_link(data: bytes, *, page: int, index: int) -> bytes:
    doc = _open(data)
    try:
        pg = _page(doc, page)
        links = pg.get_links()
        if index < 0 or index >= len(links):
            raise InvalidParams(f"link {index} not found on page {page}")
        pg.delete_link(links[index])
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Stamping suite
# --------------------------------------------------------------------------- #
def _band(page: fitz.Page, position: str, margin: float, height: float) -> fitz.Rect:
    """The strip a header/footer segment is drawn into, in *display* space."""
    w, h = page.rect.width, page.rect.height
    top = position.startswith("top")
    y0 = margin if top else h - margin - height
    third = (w - 2 * margin) / 3
    column = {"left": 0, "center": 1, "right": 2}[position.split("-", 1)[1]]
    x0 = margin + column * third
    return fitz.Rect(x0, y0, x0 + third, y0 + height)


def _tokens(text: str, *, page_number: int, total: int, date: str) -> str:
    """`{page}`/`{total}`/`{date}`. `total` counts the *stamped* pages, because
    `{page}` counts them too — "1 of 10" on the second page of a ten-page
    document whose cover was skipped is two different numbering schemes in one
    string."""
    return (str(text or "")
            .replace("{page}", str(page_number))
            .replace("{total}", str(total))
            .replace("{date}", date))


def _today() -> str:
    from datetime import datetime

    return datetime.now(UTC).strftime("%Y-%m-%d")


def _draw_band(page: fitz.Page, position: str, text: str, style: dict,
               margin: float) -> None:
    size = float(style.get("size") or 9)
    align = "center" if position.endswith("center") else (
        "right" if position.endswith("right") else "left"
    )
    # `_band` is computed in display space and handed straight to
    # `insert_htmlbox`, which is the writer that applies the page rotation
    # itself — so a footer on a rotated page lands where the reader sees the
    # bottom, reading the right way up.
    page.insert_htmlbox(
        _band(page, position, margin, size * 2.2),
        _html_block(text, {**style, "align": align}, default_size=size),
        scale_low=0.5,
    )


def header_footer(data: bytes, *, segments: dict, style: dict | None = None,
                  margin: float = 28.0, range: dict | None = None,
                  start_at: int = 1) -> bytes:
    """Six slots (left/center/right × header/footer) with `{page}`/`{total}`/`{date}`."""
    active = {k: v for k, v in (segments or {}).items() if v and k in POSITIONS}
    if not active:
        raise InvalidParams("no header/footer segments were provided")
    style = style or {}
    doc = _open(data)
    try:
        indices = _resolve_pages(doc, range)
        total = len(indices)
        date = _today()
        for ordinal, page_index in enumerate(indices):
            page = doc[page_index]
            for position, text in active.items():
                rendered = _tokens(text, page_number=start_at + ordinal,
                                   total=total, date=date)
                _draw_band(page, position, rendered, style, margin)
        _subset(doc)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def page_numbers(data: bytes, *, position: str = "bottom-center",
                 format: str = "{page}", start_at: int = 1,
                 style: dict | None = None, margin: float = 28.0,
                 range: dict | None = None) -> bytes:
    """Page numbers are a header/footer with one slot filled — same drawing
    path, so they cannot drift apart in placement or token handling."""
    if position not in POSITIONS:
        raise InvalidParams(f"position must be one of {list(POSITIONS)}")
    return header_footer(data, segments={position: format}, style=style,
                         margin=margin, range=range, start_at=start_at)


def bates(data: bytes, *, prefix: str = "", suffix: str = "", start: int = 1,
          digits: int = 6, position: str = "bottom-right",
          style: dict | None = None, margin: float = 28.0,
          range: dict | None = None) -> tuple[bytes, dict]:
    """Bates numbering — applied atomically, and the result reports the range
    actually stamped so the next batch can start where this one ended."""
    if position not in POSITIONS:
        raise InvalidParams(f"position must be one of {list(POSITIONS)}")
    if not 1 <= int(digits) <= 12:
        raise InvalidParams("digits must be between 1 and 12")
    if int(start) < 0:
        raise InvalidParams("start must be >= 0")
    doc = _open(data)
    try:
        indices = _resolve_pages(doc, range)
        style = style or {}
        first = last = None
        for ordinal, page_index in enumerate(indices):
            value = f"{prefix}{str(int(start) + ordinal).zfill(int(digits))}{suffix}"
            first = first if first is not None else value
            last = value
            _draw_band(doc[page_index], position, value, style, margin)
        _subset(doc)
        return doc.tobytes(**_SAVE), {"first": first, "last": last,
                                      "pages": len(indices)}
    finally:
        doc.close()


def watermark(data: bytes, *, text: str = "", image: bytes | None = None,
              opacity: float = 0.25, rotation: int = -45, scale: float = 1.0,
              tiled: bool = False, color=None, size: float = 48.0,
              under: bool = False, range: dict | None = None) -> bytes:
    """Text or image watermark.

    `under=True` draws beneath the page content, which is what keeps the
    document readable *and* keeps its text extractable — the watermark is not in
    the way of anything.
    """
    if not text and not image:
        raise InvalidParams("a watermark needs text or an image")
    if not 0 < float(opacity) <= 1:
        raise InvalidParams("opacity must be between 0 and 1")
    doc = _open(data)
    try:
        indices = _resolve_pages(doc, range)
        for page_index in indices:
            page = doc[page_index]
            if image:
                _watermark_image(page, image, opacity, scale, tiled, under)
            else:
                _watermark_text(page, text, opacity, rotation, scale, color, size,
                                tiled, under)
        _subset(doc)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def _watermark_positions(page: fitz.Page, tiled: bool, w: float, h: float):
    if not tiled:
        rect = page.rect
        yield fitz.Rect(rect.x0 + (rect.width - w) / 2, rect.y0 + (rect.height - h) / 2,
                        rect.x0 + (rect.width + w) / 2, rect.y0 + (rect.height + h) / 2)
        return
    cols = max(1, int(page.rect.width // (w * 1.25)))
    rows = max(1, int(page.rect.height // (h * 1.6)))
    for row in range(rows):
        for col in range(cols):
            x = page.rect.x0 + col * (page.rect.width / cols)
            y = page.rect.y0 + row * (page.rect.height / rows)
            yield fitz.Rect(x, y, x + w, y + h)


def _watermark_text(page, text, opacity, rotation, scale, color, size, tiled, under):
    """Draw the text watermark at an **arbitrary** angle.

    `insert_htmlbox` — used everywhere else in this module — only rotates in
    90° steps, which silently turned the spec'd −45° default into a vertical
    270°. A watermark is one line of text with no layout to do, so it goes
    through `insert_text` with a `morph` instead, which takes any angle.
    """
    size = max(4.0, float(size) * float(scale))
    fontname = "hebo"  # Helvetica-Bold: a watermark wants weight
    text_width = fitz.get_text_length(text, fontname=fontname, fontsize=size)
    rgb = parse_color(color) if color is not None else (0.5, 0.5, 0.5)
    derot = tuple(page.derotation_matrix)
    # The page's own rotation is applied on display, so subtract it to land at
    # the angle the user asked for *as seen*.
    angle = (float(rotation) - page.rotation) % 360

    for box in _watermark_positions(page, tiled, text_width, size * 1.6):
        centre_x = (box.x0 + box.x1) / 2
        centre_y = (box.y0 + box.y1) / 2
        origin = apply_matrix_point(centre_x - text_width / 2,
                                    centre_y + size / 3, derot)
        pivot = apply_matrix_point(centre_x, centre_y, derot)
        page.insert_text(
            fitz.Point(*origin), text,
            fontname=fontname, fontsize=size, color=rgb,
            fill_opacity=float(opacity),
            morph=(fitz.Point(*pivot), fitz.Matrix(angle)),
            overlay=not under,
        )


def _watermark_image(page, image, opacity, scale, tiled, under):
    w = page.rect.width * 0.5 * float(scale)
    h = page.rect.height * 0.5 * float(scale)
    for box in _watermark_positions(page, tiled, w, h):
        # insert_image does *not* apply the page rotation — unlike the
        # insert_htmlbox path above it.
        page.insert_image(fitz.Rect(*_derotate(box, page)), stream=image,
                          overlay=not under, alpha=-1, keep_proportion=True)


def overlay_pdf(data: bytes, overlay: bytes, *, mode: str = "foreground",
                range: dict | None = None, overlay_page: int = 0) -> bytes:
    """Stamp a page of another PDF over (or under) a range — letterheads."""
    if mode not in {"foreground", "background"}:
        raise InvalidParams("mode must be 'foreground' or 'background'")
    doc = _open(data)
    src = _open(overlay)
    try:
        if overlay_page < 0 or overlay_page >= src.page_count:
            raise PageOutOfRange(f"overlay page {overlay_page} out of range")
        for page_index in _resolve_pages(doc, range):
            page = doc[page_index]
            # `show_pdf_page` places in unrotated space, so a rotated page needs
            # both the de-rotated target *and* a counter-rotation, or the
            # letterhead arrives sideways.
            page.show_pdf_page(fitz.Rect(*_derotate(page.rect, page)), src,
                               overlay_page, rotate=(-page.rotation) % 360,
                               overlay=mode == "foreground")
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()
        src.close()


# --------------------------------------------------------------------------- #
# Metadata & bookmarks
# --------------------------------------------------------------------------- #
METADATA_FIELDS = ("title", "author", "subject", "keywords", "creator", "producer")


def set_metadata(data: bytes, *, clear: bool = False, **fields) -> bytes:
    doc = _open(data)
    try:
        if clear:
            doc.set_metadata({})
        else:
            current = dict(doc.metadata or {})
            for key in METADATA_FIELDS:
                if key in fields and fields[key] is not None:
                    current[key] = str(fields[key])[:500]
            # `format` and `encryption` are reported by PyMuPDF but are not
            # writable keys; passing them back raises.
            current.pop("format", None)
            current.pop("encryption", None)
            doc.set_metadata(current)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def set_bookmarks(data: bytes, *, toc: list) -> bytes:
    """Replace the outline. `toc` is `[[level, title, page(1-based)], …]`."""
    doc = _open(data)
    try:
        cleaned = []
        last_level = 0
        for entry in toc or []:
            if not isinstance(entry, (list, tuple)) or len(entry) < 3:
                raise InvalidParams("each bookmark must be [level, title, page]")
            level, title, page = int(entry[0]), str(entry[1]), int(entry[2])
            if level < 1:
                raise InvalidParams("bookmark level must be >= 1")
            # PyMuPDF rejects a tree that jumps a level; catching it here names
            # the offending entry instead of failing the whole save.
            if level > last_level + 1:
                raise InvalidParams(
                    f"bookmark '{title}' jumps from level {last_level} to {level}"
                )
            if page < 1 or page > doc.page_count:
                raise PageOutOfRange(f"bookmark '{title}' points at page {page}")
            cleaned.append([level, title[:500], page])
            last_level = level
        doc.set_toc(cleaned)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()
