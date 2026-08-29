"""Annotations engine (phase-03; 01-architecture.md §8, §10).

**PDF-native storage.** Annotations live in the PDF file itself as real annotation
objects (Acrobat/Preview interoperable), not in a sidecar table. Reading is
extraction; writing is one `annotate_batch` job producing a new immutable version
(§11, §14). Downloads and interop therefore "just work", versioning/undo comes
free, and there is no dual source of truth to drift.

Client-side identity is the `/NM` key: a UUID the client generates, so batch
update/delete ops address stable ids across extract→apply cycles. Authorship is
the display name or **"Guest"** — never the session id or IP, because the value
ends up inside a file the user will share (phase-03 §3).

All geometry crosses this boundary normalized (§8) and is converted in exactly
one place: `..geometry`.
"""
from __future__ import annotations

import fitz

from ..colors import format_color, parse_color
from ..exceptions import InvalidParams, UnsupportedFileError
from ..geometry import (
    NormRect,
    apply_matrix_point,
    apply_matrix_rect,
    content_rotation,
    norm_to_page_point,
    norm_to_page_rect,
    page_point_to_norm,
    page_rect_to_norm,
)

# Deliberately *without* `clean=True` (which pages.py uses): the sanitizer
# rewrites content streams, and image stamps carry an appearance stream we build
# by hand. `garbage=4` still prunes, and it reaches our AP resources through the
# annot, so nothing we write is collected.
_SAVE = dict(garbage=4, deflate=True, deflate_images=True, deflate_fonts=True)

# Text-markup types take quads from a text selection; everything else is
# geometric. Kept as sets so the dispatch below stays declarative.
MARKUP_TYPES = frozenset({"highlight", "underline", "strikeout", "squiggly"})
GEOMETRIC_TYPES = frozenset(
    {"note", "free_text", "square", "circle", "line", "arrow", "polygon",
     "polyline", "ink", "stamp", "image_stamp"}
)
ANNOTATION_TYPES = MARKUP_TYPES | GEOMETRIC_TYPES

# PDF standard stamp names, in PyMuPDF's `stamp=` index order.
STANDARD_STAMPS = (
    "Approved", "AsIs", "Confidential", "Departmental", "Draft", "Experimental",
    "Expired", "Final", "ForComment", "ForPublicRelease", "NotApproved",
    "NotForPublicRelease", "Sold", "TopSecret",
)

# PyMuPDF subtype string → our wire type. Ink/Line/Stamp are ambiguous on the way
# back (arrow is a Line with an end style; image_stamp is a Stamp with our own
# appearance stream), so those are disambiguated in `_read_annot`.
_SUBTYPE_TO_TYPE = {
    "Highlight": "highlight",
    "Underline": "underline",
    "StrikeOut": "strikeout",
    "Squiggly": "squiggly",
    "Text": "note",
    "FreeText": "free_text",
    "Square": "square",
    "Circle": "circle",
    "Line": "line",
    "Polygon": "polygon",
    "PolyLine": "polyline",
    "Ink": "ink",
    "Stamp": "stamp",
}

# Marker key written on Stamp annots we built from an uploaded image, so a
# round-trip can tell them apart from a standard stamp (and re-offer the image).
_IMAGE_STAMP_KEY = "ZenImageStamp"


# --------------------------------------------------------------------------- #
# Open helper (shared behaviour with pages.py: encrypted files are refused)
# --------------------------------------------------------------------------- #
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
        from ..exceptions import PageOutOfRange

        raise PageOutOfRange(f"page {i} out of range (0..{doc.page_count - 1})")
    return doc[i]


# --------------------------------------------------------------------------- #
# Extraction
# --------------------------------------------------------------------------- #
def _quads_of(annot: fitz.Annot, w: float, h: float, rot) -> list[dict]:
    """Markup vertices arrive as flat groups of 4 corner points per quad."""
    pts = list(annot.vertices or [])
    quads = []
    for i in range(0, len(pts) - 3, 4):
        group = pts[i:i + 4]
        xs = [p[0] for p in group]
        ys = [p[1] for p in group]
        x0, y0, x1, y1 = apply_matrix_rect(
            min(xs), min(ys), max(xs), max(ys), rot
        )
        nr = page_rect_to_norm(x0, y0, x1, y1, w, h)
        quads.append({"x": nr.x, "y": nr.y, "w": nr.w, "h": nr.h})
    return quads


def _read_annot(annot: fitz.Annot, page_index: int, w: float, h: float,
                rot) -> dict:
    subtype = annot.type[1]
    kind = _SUBTYPE_TO_TYPE.get(subtype)
    if kind is None:
        return {}
    info = annot.info or {}
    rect = annot.rect
    # Back to display space: `annot.rect` is in the page's unrotated space.
    x0, y0, x1, y1 = apply_matrix_rect(rect.x0, rect.y0, rect.x1, rect.y1, rot)
    nr = page_rect_to_norm(x0, y0, x1, y1, w, h)
    colors = annot.colors or {}
    opacity = annot.opacity
    out: dict = {
        "id": info.get("id") or "",
        "page": page_index,
        "type": kind,
        "rect": {"x": nr.x, "y": nr.y, "w": nr.w, "h": nr.h},
        "color": format_color(colors.get("stroke")),
        "fill": format_color(colors.get("fill")),
        # PyMuPDF answers -1 for "no /CA entry", which means fully opaque.
        "opacity": round(float(opacity), 4) if opacity is not None and opacity >= 0 else 1.0,
        "width": round(float((annot.border or {}).get("width") or 0.0), 2),
        "contents": info.get("content", ""),
        "author": info.get("title", ""),
        "created": info.get("creationDate", ""),
        "modified": info.get("modDate", ""),
    }

    if kind in MARKUP_TYPES:
        out["quads"] = _quads_of(annot, w, h, rot)
    elif kind == "ink":
        out["ink"] = [
            [
                list(page_point_to_norm(*apply_matrix_point(p[0], p[1], rot), w, h))
                for p in stroke
            ]
            for stroke in (annot.vertices or [])
        ]
    elif kind in {"line", "polygon", "polyline"}:
        out["vertices"] = [
            list(page_point_to_norm(*apply_matrix_point(p[0], p[1], rot), w, h))
            for p in (annot.vertices or [])
        ]
        if kind == "line" and tuple(annot.line_ends or (0, 0))[1]:
            out["type"] = "arrow"
    elif kind == "note":
        out["icon"] = info.get("name") or "Note"
    elif kind == "free_text":
        size, color = _freetext_da(annot)
        out["font_size"] = size
        # For FreeText, `color` on the wire is the *text* colour (that is what
        # the user picked); the annot's stroke colour is its border.
        out["color"] = color or out["color"]
        out["align"] = int(getattr(annot, "text_align", 0) or 0)
    elif kind == "stamp":
        doc = annot.parent.parent
        if doc.xref_get_key(annot.xref, _IMAGE_STAMP_KEY)[0] != "null":
            out["type"] = "image_stamp"
            out["image_ref"] = doc.xref_get_key(annot.xref, _IMAGE_STAMP_KEY)[1]
        else:
            out["stamp_name"] = info.get("name") or ""
    return out


def _freetext_da(annot: fitz.Annot) -> tuple[float, str | None]:
    """FreeText size and text colour live in the /DA string ('… 0 0 1 rg /F 12 Tf')."""
    doc = annot.parent.parent
    kind, da = doc.xref_get_key(annot.xref, "DA")
    size, color = 12.0, None
    if kind == "null" or not da:
        return size, color
    parts = str(da).split()
    for i, tok in enumerate(parts):
        if tok == "Tf" and i >= 1:
            try:
                size = round(float(parts[i - 1]), 2)
            except ValueError:
                pass
        elif tok == "rg" and i >= 3:
            try:
                color = format_color([float(parts[i - 3]), float(parts[i - 2]),
                                      float(parts[i - 1])])
            except ValueError:
                pass
        elif tok == "g" and i >= 1:
            try:
                grey = float(parts[i - 1])
                color = format_color([grey, grey, grey])
            except ValueError:
                pass
    return size, color


def extract_annotations(data: bytes, *, pages: list[int] | None = None) -> list[dict]:
    """All annotations as wire objects with normalized geometry (§8)."""
    doc = _open(data)
    try:
        indices = pages if pages is not None else range(doc.page_count)
        out: list[dict] = []
        for i in indices:
            if i < 0 or i >= doc.page_count:
                continue
            page = doc[i]
            w, h = page.rect.width, page.rect.height
            rot = tuple(page.rotation_matrix)
            for annot in page.annots():
                item = _read_annot(annot, i, w, h, rot)
                if item:
                    out.append(item)
        return out
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #
def _norm_rect(value, what: str) -> NormRect:
    """`NormRect` raises `ValueError` for an off-page rect; that must reach the
    client as `validation_error`, not as a bare `engine_error` that says
    "Operation failed"."""
    try:
        return NormRect.from_dict(value)
    except ValueError as exc:
        raise InvalidParams(f"invalid {what}: {exc}") from exc


def _to_annot_rect(norm: NormRect, page: fitz.Page) -> fitz.Rect:
    """Normalized *display* rect → the page's annotation coordinate space.

    The de-rotation is the whole point: `page.rect` is rotation-applied but
    `add_*_annot` is not, so on a /Rotate 90 page a mark placed top-left would
    otherwise be written top-right (§8, amended).
    """
    x0, y0, x1, y1 = norm_to_page_rect(norm, page.rect.width, page.rect.height)
    x0, y0, x1, y1 = apply_matrix_rect(x0, y0, x1, y1, tuple(page.derotation_matrix))
    return fitz.Rect(x0, y0, x1, y1)


def _rect_of(spec: dict, page: fitz.Page) -> fitz.Rect:
    if "rect" not in spec:
        raise InvalidParams(f"'{spec.get('type')}' annotations require a rect")
    return _to_annot_rect(_norm_rect(spec["rect"], "rect"), page)


def _points_of(spec: dict, key: str, page: fitz.Page) -> list[tuple[float, float]]:
    raw = spec.get(key) or []
    if len(raw) < 2:
        raise InvalidParams(f"'{key}' needs at least two points")
    w, h = page.rect.width, page.rect.height
    derot = tuple(page.derotation_matrix)
    return [
        apply_matrix_point(*norm_to_page_point(float(p[0]), float(p[1]), w, h), derot)
        for p in raw
    ]


def _apply_common(annot: fitz.Annot, spec: dict, author: str, *,
                  set_colors: bool = True, title: str | None = None) -> None:
    """Shared annot properties. `set_colors=False` for FreeText, where the
    creation call already placed the *text* colour in /DA and a stroke write
    would overwrite it with a border colour the user never chose.

    `spec["author"]` is deliberately **ignored**. The field exists on the wire
    only so an extracted annotation round-trips through an update unchanged; if
    it were honoured, a client could stamp any name it liked into a file — and
    §3's "display name, or Guest" would be client-controlled. `title` carries an
    existing annotation's author so editing someone else's comment does not
    reassign it (matching Acrobat).
    """
    if set_colors:
        stroke = parse_color(spec.get("color"))
        fill = parse_color(spec.get("fill"))
        if stroke is not None or fill is not None:
            # `colors` is per-key; passing None leaves that key alone.
            annot.set_colors(stroke=stroke, fill=fill)
    if spec.get("opacity") is not None:
        annot.set_opacity(max(0.0, min(1.0, float(spec["opacity"]))))
    width = spec.get("width")
    if width is not None and float(width) > 0:
        annot.set_border(width=float(width))
    now = fitz.get_pdf_now()
    annot.set_info(
        content=str(spec.get("contents") or ""),
        title=str(title or author or "Guest"),
        creationDate=str(spec.get("created") or now),
        modDate=now,
    )


def _embed_images(doc: fitz.Document, images: dict[str, bytes]) -> dict[str, int]:
    """Add each uploaded PNG to the file once as an Image XObject; ref → xref.

    Done up front, before a single annotation is touched. Getting an XObject into
    a PDF requires inserting it on a page, and creating or deleting a page
    invalidates every live `Page`/`Annot` handle in MuPDF — which is a *segfault*,
    not an exception. Hoisting it here means no handle ever spans a page
    mutation, and stamping the same image ten times still embeds it once.
    """
    out: dict[str, int] = {}
    for ref, png in (images or {}).items():
        scratch = doc.new_page(width=200, height=200)
        scratch.insert_image(scratch.rect, stream=png)
        embedded = scratch.get_images(full=True)
        number = scratch.number
        del scratch
        doc.delete_page(number)
        if embedded:
            out[ref] = embedded[0][0]
    return out


_AP_ROTATION = {
    0: "[1 0 0 1 0 0]",
    90: "[0 1 -1 0 0 0]",
    180: "[-1 0 0 -1 0 0]",
    270: "[0 -1 1 0 0 0]",
}


def _write_image_ap(doc: fitz.Document, annot: fitz.Annot, rect: fitz.Rect,
                    img_xref: int, ref: str, rotate: int = 0) -> None:
    """Give a Stamp annot our own appearance stream drawing an embedded image.

    The alternative sanctioned by phase-03 — drawing the image straight into page
    content via `insert_image` and tracking it as a pseudo-annotation — is not
    used: the golden test (`test_image_stamp_renders_and_round_trips`) shows the
    appearance-stream path renders the pixels *and* keeps a real, addressable
    annotation object, so the fallback would trade interop away for nothing.

    `rotate` is the page's own rotation (`geometry.content_rotation`). An
    appearance stream is drawn in the page's unrotated space and turns with the
    page, so without it a stamp placed on a /Rotate 90 page renders a quarter
    turn from how the user placed it. The turn goes in the **`/Matrix`**, which
    is the mechanism PDF 32000-1 §12.5.5 provides for exactly this: the BBox is
    transformed by Matrix and the *bounding box of the result* is then mapped
    onto the annotation's `/Rect`. So the content is laid out at the displayed
    size and the rotated result lands back on the rect it was given.
    """
    annot.update()
    kind, ap = doc.xref_get_key(annot.xref, "AP/N")
    if kind != "xref":
        raise InvalidParams("could not build the image stamp appearance")
    ap_xref = int(str(ap).split()[0])
    # At a quarter turn the drawn box is the rect with its sides swapped: it is
    # the *displayed* box, which is what the image has to fill.
    quarter = rotate in (90, 270)
    dw = rect.height if quarter else rect.width
    dh = rect.width if quarter else rect.height
    doc.xref_set_key(ap_xref, "Resources", f"<</XObject<</ZenIm {img_xref} 0 R>>>>")
    doc.xref_set_key(ap_xref, "BBox", f"[0 0 {dw} {dh}]")
    doc.xref_set_key(ap_xref, "Matrix", _AP_ROTATION[rotate])
    doc.update_stream(ap_xref, f"q {dw} 0 0 {dh} 0 0 cm /ZenIm Do Q".encode())
    doc.xref_set_key(annot.xref, _IMAGE_STAMP_KEY, fitz.get_pdf_str(ref))


def _restore_stamp_rect_and_contents(page: fitz.Page, annot: fitz.Annot,
                                     rect: fitz.Rect, spec: dict) -> None:
    """Undo the two things MuPDF's stamp machinery decides over the caller.

    **The rect.** `add_stamp_annot` aspect-fits `/Rect` to the built-in
    appearance (a 190×80 box becomes 190×50 for "Approved"), so the mark
    landed squashed relative to what the user drew — for an image stamp the
    pixels were then stretched into the *reshaped* box. The rect is written
    back **as a raw `/Rect` key**, not with `set_rect`: `set_rect` marks the
    annotation dirty, and MuPDF re-synthesises dirty stamps when a *later* op
    loads another page — re-fitting the rect all over again (and, for an image
    stamp, entitled to rebuild the appearance we just replaced). A raw key
    write leaves the annotation clean, so nothing revisits it; the viewer then
    scales the appearance's BBox onto `/Rect` and the stamp fills the box the
    user drew. The PDF-space value is `rect × ~transformation_matrix` — probed
    equal to what `set_rect` writes, on /Rotate 0/90/180 and offset-CropBox
    pages alike.

    **The contents.** `annot.update()` writes the stamp's own name into
    `/Contents`, silently replacing whatever comment the user typed ("Approved"
    turned up as every stamp's comment — and as every *image* stamp's, which is
    stranger). Re-asserted as a raw key too — `set_info` sets MuPDF's dirty
    flag exactly like `set_rect`, and `set_info(content="")` is a no-op besides
    — with `get_pdf_str` doing the PDF string escaping.
    """
    doc = page.parent
    pdf_rect = (rect * ~page.transformation_matrix).normalize()
    doc.xref_set_key(annot.xref, "Rect",
                     f"[{pdf_rect.x0} {pdf_rect.y0} {pdf_rect.x1} {pdf_rect.y1}]")
    doc.xref_set_key(annot.xref, "Contents",
                     fitz.get_pdf_str(str(spec.get("contents") or "")))


def _add_annotation(page: fitz.Page, spec: dict, author: str,
                    image_xrefs: dict[str, int], *,
                    title: str | None = None) -> fitz.Annot:
    kind = spec.get("type")
    if kind not in ANNOTATION_TYPES:
        raise InvalidParams(f"unknown annotation type '{kind}'")

    if kind in MARKUP_TYPES:
        quads = spec.get("quads") or []
        if not quads:
            raise InvalidParams(f"'{kind}' requires at least one quad")
        fitz_quads = [
            _to_annot_rect(_norm_rect(q, "quad"), page).quad for q in quads
        ]
        adder = {
            "highlight": page.add_highlight_annot,
            "underline": page.add_underline_annot,
            "strikeout": page.add_strikeout_annot,
            "squiggly": page.add_squiggly_annot,
        }[kind]
        annot = adder(fitz_quads)
    elif kind == "note":
        rect = _rect_of(spec, page)
        annot = page.add_text_annot(
            fitz.Point(rect.x0, rect.y0),
            str(spec.get("contents") or ""),
            icon=str(spec.get("icon") or "Note"),
        )
    elif kind == "free_text":
        rect = _rect_of(spec, page)
        annot = page.add_freetext_annot(
            rect,
            str(spec.get("contents") or ""),
            # A comment is typed onto the page the reader is looking at, so it
            # reads upright to that reader — the same rule the burnt-in
            # surfaces follow. Without this it turns with the page and a note
            # on a /Rotate 90 scan arrives sideways.
            rotate=content_rotation(page.rotation),
            fontsize=float(spec.get("font_size") or 12),
            text_color=parse_color(spec.get("color")) or (0, 0, 0),
            fill_color=parse_color(spec.get("fill")),
            border_width=float(spec.get("width") or 0),
            align=int(spec.get("align") or 0),
        )
    elif kind == "square":
        annot = page.add_rect_annot(_rect_of(spec, page))
    elif kind == "circle":
        annot = page.add_circle_annot(_rect_of(spec, page))
    elif kind in {"line", "arrow"}:
        pts = _points_of(spec, "vertices", page)
        annot = page.add_line_annot(fitz.Point(*pts[0]), fitz.Point(*pts[-1]))
        if kind == "arrow":
            annot.set_line_ends(fitz.PDF_ANNOT_LE_NONE, fitz.PDF_ANNOT_LE_CLOSED_ARROW)
    elif kind == "polygon":
        annot = page.add_polygon_annot([fitz.Point(*p) for p in _points_of(spec, "vertices", page)])
    elif kind == "polyline":
        annot = page.add_polyline_annot([fitz.Point(*p) for p in _points_of(spec, "vertices", page)])
    elif kind == "ink":
        strokes = spec.get("ink") or []
        w, h = page.rect.width, page.rect.height
        derot = tuple(page.derotation_matrix)
        converted = [
            [
                apply_matrix_point(
                    *norm_to_page_point(float(p[0]), float(p[1]), w, h), derot
                )
                for p in stroke
            ]
            for stroke in strokes
            if len(stroke) >= 1
        ]
        if not converted:
            raise InvalidParams("'ink' requires at least one stroke")
        # A single-point stroke is a dot the user genuinely drew; PyMuPDF needs
        # two points to make a segment out of it.
        converted = [s if len(s) > 1 else [s[0], (s[0][0] + 0.5, s[0][1] + 0.5)] for s in converted]
        annot = page.add_ink_annot(converted)
    elif kind == "stamp":
        name = str(spec.get("stamp_name") or STANDARD_STAMPS[0])
        if name not in STANDARD_STAMPS:
            raise InvalidParams(f"unknown stamp '{name}'")
        rect = _rect_of(spec, page)
        annot = page.add_stamp_annot(rect, stamp=STANDARD_STAMPS.index(name))
        _apply_common(annot, spec, author, title=title)
        annot.update()
        _restore_stamp_rect_and_contents(page, annot, rect, spec)
        return annot
    else:  # image_stamp
        ref = str(spec.get("image_ref") or "")
        img_xref = image_xrefs.get(ref)
        if not img_xref:
            raise InvalidParams(f"stamp image '{ref}' was not provided")
        rect = _rect_of(spec, page)
        annot = page.add_stamp_annot(rect, stamp=0)
        _apply_common(annot, spec, author, title=title)
        _write_image_ap(page.parent, annot, rect, img_xref, ref,
                        rotate=content_rotation(page.rotation))
        _restore_stamp_rect_and_contents(page, annot, rect, spec)
        return annot

    _apply_common(annot, spec, author, set_colors=kind != "free_text", title=title)
    annot.update()
    return annot


def _index_by_nm(doc: fitz.Document) -> dict[str, tuple[int, int]]:
    """NM → (page index, annot xref). Built once so ops never iterate a page's
    annotation list while mutating it."""
    index: dict[str, tuple[int, int]] = {}
    for i in range(doc.page_count):
        # Bind the page to a local: PyMuPDF holds `annot.parent` by weak
        # reference, so iterating `doc[i].annots()` directly lets the temporary
        # Page be collected mid-loop and every annot attribute reads freed
        # memory — a segfault, not an exception.
        page = doc[i]
        for annot in page.annots():
            nm = (annot.info or {}).get("id")
            if nm:
                index[nm] = (i, annot.xref)
    return index


def _find(doc: fitz.Document, index: dict, nm: str):
    hit = index.get(nm)
    if hit is None:
        return None, None
    page_index, xref = hit
    page = doc[page_index]
    for annot in page.annots():
        if annot.xref == xref:
            return page, annot
    return None, None


def apply_annotation_ops(data: bytes, *, ops: list[dict], author: str = "Guest",
                         images: dict[str, bytes] | None = None) -> tuple[bytes, dict]:
    """Apply add/update/delete ops addressed by `/NM`. Returns (bytes, report).

    An **update is delete-then-add with the same NM**. Per-type in-place mutators
    would need one branch per property per type and still have to force an
    appearance rebuild; re-adding from the full spec the client already sends is
    both shorter and uniformly correct — the client is the source of truth for a
    draft anyway (phase-03 §2, session batching).
    """
    if not isinstance(ops, list) or not ops:
        raise InvalidParams("`ops` must be a non-empty list.")
    doc = _open(data)
    try:
        # Must precede everything else: it mutates the page list (see _embed_images).
        image_xrefs = _embed_images(doc, images or {})
        index = _index_by_nm(doc)
        report = {"added": 0, "updated": 0, "deleted": 0, "missing": 0}

        for op in ops:
            action = (op or {}).get("action")
            if action not in {"add", "update", "delete"}:
                raise InvalidParams(f"unknown annotation action '{action}'")
            spec = (op or {}).get("annotation") or {}
            nm = str(spec.get("id") or "")
            if not nm:
                raise InvalidParams("every annotation op needs an `annotation.id` (NM)")

            if action == "delete":
                page, annot = _find(doc, index, nm)
                if annot is None:
                    # A draft deleted on another tab, or replayed after a reload.
                    # Idempotent by design (phase-03 §"Save model UX").
                    report["missing"] += 1
                    continue
                page.delete_annot(annot)
                index.pop(nm, None)
                report["deleted"] += 1
                continue

            existing_page, existing = _find(doc, index, nm)
            created = None
            existing_title = None
            if existing is not None:
                # Replaying an `add` for an NM that is already there is an
                # update, not a duplicate — the client replays drafts after a
                # version conflict (phase-03 §"Save model UX").
                info = existing.info or {}
                created = info.get("creationDate") or None
                existing_title = info.get("title") or None
                existing_page.delete_annot(existing)
                index.pop(nm, None)
                report["updated"] += 1
            else:
                if action == "update":
                    # Updating something that is gone re-creates it rather than
                    # failing the whole batch: the batch is one job, and one
                    # stale draft must not discard 29 good ones.
                    report["missing"] += 1
                report["added"] += 1

            page = _page(doc, spec.get("page", 0))
            if created and not spec.get("created"):
                spec = {**spec, "created": created}
            annot = _add_annotation(page, spec, author, image_xrefs, title=existing_title)
            doc.xref_set_key(annot.xref, "NM", fitz.get_pdf_str(nm))
            index[nm] = (page.number, annot.xref)

        return doc.tobytes(**_SAVE), report
    finally:
        doc.close()


def flatten_annotations(data: bytes, *, what: str = "annotations") -> bytes:
    """Bake annotations and/or form widgets into page content and drop the objects.

    `Document.bake()` (PyMuPDF ≥1.24.2) is the sanctioned implementation
    (phase-03 "implementation directive"). Phase 5 reuses it for `what=form`.
    """
    if what not in {"annotations", "form", "all"}:
        raise InvalidParams("`what` must be one of: annotations, form, all")
    doc = _open(data)
    try:
        doc.bake(annots=what in {"annotations", "all"}, widgets=what in {"form", "all"})
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()
