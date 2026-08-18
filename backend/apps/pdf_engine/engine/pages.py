"""Phase-2 page operations — all pure functions (01-architecture.md §10, phase-02).

Each mutation returns new PDF bytes; document-producing ops (split, extract,
merge, alternate_mix) return list[dict(data, title)]. Guardrails per phase-02:
page indexes validated, ≥1 page must remain, reorder must be a permutation.

Page indices are 0-based everywhere (matching §8 client convention).
"""
from __future__ import annotations

import io

import fitz

from ..exceptions import InvalidParams, PageOutOfRange, UnsupportedFileError, WouldDeleteAllPages
from ..geometry import NormRect, norm_to_page_rect

PAGE_SIZES = {
    "a4": (595.0, 842.0),
    "letter": (612.0, 792.0),
    "legal": (612.0, 1008.0),
}
_SAVE = dict(garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True)


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


def _validate_indices(pages, n: int) -> list[int]:
    if not isinstance(pages, (list, tuple)) or len(pages) == 0:
        raise InvalidParams("`pages` must be a non-empty list of page indices.")
    out = []
    for p in pages:
        p = int(p)
        if p < 0 or p >= n:
            raise PageOutOfRange(f"page {p} out of range (0..{n - 1})")
        out.append(p)
    return out


def _resolve_size(name_or_tuple, fallback=(595.0, 842.0)):
    if isinstance(name_or_tuple, (list, tuple)) and len(name_or_tuple) == 2:
        return float(name_or_tuple[0]), float(name_or_tuple[1])
    key = str(name_or_tuple or "").lower()
    return PAGE_SIZES.get(key, fallback)


# --------------------------------------------------------------------------- #
# In-place single-document mutations → new version
# --------------------------------------------------------------------------- #
def rotate_pages(data: bytes, *, pages: list[int], degrees: int) -> bytes:
    if degrees not in (90, 180, 270):
        raise InvalidParams("degrees must be one of 90, 180, 270.")
    doc = _open(data)
    try:
        indices = _validate_indices(pages, doc.page_count)
        for i in indices:
            page = doc[i]
            page.set_rotation((page.rotation + degrees) % 360)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def delete_pages(data: bytes, *, pages: list[int]) -> bytes:
    doc = _open(data)
    try:
        indices = sorted(set(_validate_indices(pages, doc.page_count)))
        if len(indices) >= doc.page_count:
            raise WouldDeleteAllPages("At least one page must remain.")
        doc.delete_pages(indices)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def duplicate_pages(data: bytes, *, pages: list[int]) -> bytes:
    doc = _open(data)
    try:
        n = doc.page_count
        dup = set(_validate_indices(pages, n))
        new_order: list[int] = []
        for i in range(n):
            new_order.append(i)
            if i in dup:
                new_order.append(i)
        doc.select(new_order)  # PyMuPDF select supports duplicates + reordering
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def reorder_pages(data: bytes, *, new_order: list[int]) -> bytes:
    doc = _open(data)
    try:
        n = doc.page_count
        if sorted(int(i) for i in new_order) != list(range(n)):
            raise InvalidParams("new_order must be a permutation of all page indices.")
        doc.select([int(i) for i in new_order])
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def insert_blank(data: bytes, *, at_index: int, count: int = 1, size="a4") -> bytes:
    doc = _open(data)
    try:
        n = doc.page_count
        if at_index < 0 or at_index > n:
            raise PageOutOfRange(f"at_index {at_index} out of range (0..{n})")
        if count < 1:
            raise InvalidParams("count must be >= 1.")
        if str(size).lower() == "match-previous" and at_index > 0:
            prev = doc[at_index - 1].rect
            w, h = prev.width, prev.height
        else:
            w, h = _resolve_size(size)
        for k in range(count):
            doc.new_page(pno=at_index + k, width=w, height=h)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def insert_from_document(data: bytes, source: bytes, *, source_pages: list[int] | None,
                         at_index: int) -> bytes:
    doc = _open(data)
    src = _open(source)
    try:
        n = doc.page_count
        if at_index < 0 or at_index > n:
            raise PageOutOfRange(f"at_index {at_index} out of range (0..{n})")
        if source_pages:
            for p in source_pages:
                if p < 0 or p >= src.page_count:
                    raise PageOutOfRange(f"source page {p} out of range")
            # insert requested pages, preserving their order, at at_index
            for offset, p in enumerate(source_pages):
                doc.insert_pdf(src, from_page=p, to_page=p, start_at=at_index + offset)
        else:
            doc.insert_pdf(src, start_at=at_index)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()
        src.close()


def crop_pages(data: bytes, *, pages: list[int], rect: dict) -> bytes:
    """Set the cropbox from a normalized visual-space rect (§8), rotation-aware."""
    norm = NormRect.from_dict(rect)
    doc = _open(data)
    try:
        indices = _validate_indices(pages, doc.page_count)
        for i in indices:
            page = doc[i]
            x0, y0, x1, y1 = norm_to_page_rect(norm, page.rect.width, page.rect.height)
            visual = fitz.Rect(x0, y0, x1, y1)
            # Cropbox is defined in unrotated PDF space; derotate the visual rect.
            unrot = visual * page.derotation_matrix
            unrot.normalize()
            # Clamp to mediabox to satisfy PyMuPDF's containment requirement.
            unrot = unrot & page.mediabox
            page.set_cropbox(unrot)
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def scale_pages(data: bytes, *, pages: list[int], target_size="a4") -> bytes:
    """Rebuild selected pages at target_size, scaling content to fit."""
    src = _open(data)
    try:
        n = src.page_count
        targets = set(_validate_indices(pages, n))
        tw, th = _resolve_size(target_size)
        out = fitz.open()
        for i in range(n):
            if i in targets:
                new = out.new_page(width=tw, height=th)
                new.show_pdf_page(new.rect, src, i)
            else:
                out.insert_pdf(src, from_page=i, to_page=i)
        return out.tobytes(**_SAVE)
    finally:
        src.close()


def nup(data: bytes, *, per_sheet: int = 2, page_size="a4") -> bytes:
    if per_sheet not in (2, 4):
        raise InvalidParams("per_sheet must be 2 or 4.")
    src = _open(data)
    try:
        sw, sh = _resolve_size(page_size)
        # 2-up: landscape sheet, 1 row x 2 cols. 4-up: portrait, 2x2.
        if per_sheet == 2:
            sheet_w, sheet_h, cols, rows = sh, sw, 2, 1
        else:
            sheet_w, sheet_h, cols, rows = sw, sh, 2, 2
        out = fitz.open()
        cell_w, cell_h = sheet_w / cols, sheet_h / rows
        n = src.page_count
        for start in range(0, n, per_sheet):
            sheet = out.new_page(width=sheet_w, height=sheet_h)
            for slot in range(per_sheet):
                idx = start + slot
                if idx >= n:
                    break
                r, c = divmod(slot, cols)
                cell = fitz.Rect(c * cell_w, r * cell_h, (c + 1) * cell_w, (r + 1) * cell_h)
                sheet.show_pdf_page(cell, src, idx)
        return out.tobytes(**_SAVE)
    finally:
        src.close()


# --------------------------------------------------------------------------- #
# Multi-document producers
# --------------------------------------------------------------------------- #
def _subset_bytes(doc: fitz.Document, indices: list[int]) -> bytes:
    out = fitz.open()
    for i in indices:
        out.insert_pdf(doc, from_page=i, to_page=i)
    data = out.tobytes(**_SAVE)
    out.close()
    return data


def extract_pages(data: bytes, *, pages: list[int]) -> bytes:
    """Extract selected pages into one new PDF (order preserved)."""
    doc = _open(data)
    try:
        indices = _validate_indices(pages, doc.page_count)
        return _subset_bytes(doc, indices)
    finally:
        doc.close()


def extract_pages_each(data: bytes, *, pages: list[int],
                       base_title: str = "Document") -> list[dict]:
    """Extract each selected page into its own PDF. Returns [{data, title}] (§10).

    Titles carry the *source* page number, not the position in the selection:
    "page 9" is the only name that still means something once the file is
    downloaded next to forty others. Duplicates in the selection collapse —
    asking for page 3 twice describes one page, and two identically-named files
    holding the same page is a bug wearing a feature's clothes.
    """
    doc = _open(data)
    try:
        indices = _validate_indices(pages, doc.page_count)
        seen: set[int] = set()
        out = []
        for i in indices:
            if i in seen:
                continue
            seen.add(i)
            out.append({"data": _subset_bytes(doc, [i]),
                        "title": f"{base_title} — page {i + 1}"})
        return out
    finally:
        doc.close()


def merge(datas: list[bytes], *, titles: list[str] | None = None) -> bytes:
    """Concatenate PDFs; concatenate TOCs under per-document title parents."""
    if not datas or len(datas) < 2:
        raise InvalidParams("merge requires at least two documents.")
    out = fitz.open()
    combined_toc: list[list] = []
    offset = 0
    for idx, data in enumerate(datas):
        src = _open(data)
        try:
            out.insert_pdf(src)
            title = (titles[idx] if titles and idx < len(titles) else f"Document {idx + 1}")
            combined_toc.append([1, title, offset + 1])
            for lvl, t, pg in src.get_toc(simple=True):
                combined_toc.append([lvl + 1, t, offset + pg])
            offset += src.page_count
        finally:
            src.close()
    if combined_toc:
        out.set_toc(combined_toc)
    return out.tobytes(**_SAVE)


def alternate_mix(data_a: bytes, data_b: bytes, *, reverse_b: bool = False) -> bytes:
    da = _open(data_a)
    db = _open(data_b)
    try:
        out = fitz.open()
        b_order = list(range(db.page_count))
        if reverse_b:
            b_order.reverse()
        na, nb = da.page_count, len(b_order)
        for i in range(max(na, nb)):
            if i < na:
                out.insert_pdf(da, from_page=i, to_page=i)
            if i < nb:
                out.insert_pdf(db, from_page=b_order[i], to_page=b_order[i])
        return out.tobytes(**_SAVE)
    finally:
        da.close()
        db.close()


def _ranges_to_indices(spec: str, n: int) -> list[list[int]]:
    """Parse '1-3,7,9-12' (1-based, inclusive) → list of 0-based index groups."""
    groups: list[list[int]] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            lo, hi = int(a), int(b)
        else:
            lo = hi = int(part)
        if lo < 1 or hi > n or lo > hi:
            raise InvalidParams(f"invalid range '{part}' for {n}-page document")
        groups.append(list(range(lo - 1, hi)))
    if not groups:
        raise InvalidParams("no valid ranges provided")
    return groups


def split(data: bytes, *, mode: str, ranges: str = "", every_n: int = 1,
          max_mb: float = 5.0, base_title: str = "Document") -> list[dict]:
    """Split into multiple documents. Returns [{data, title}] (§10)."""
    doc = _open(data)
    try:
        n = doc.page_count
        results: list[dict] = []
        if mode == "ranges":
            for gi, group in enumerate(_ranges_to_indices(ranges, n), start=1):
                results.append({"data": _subset_bytes(doc, group),
                                "title": f"{base_title} — part {gi}"})
        elif mode == "every_n":
            if every_n < 1:
                raise InvalidParams("every_n must be >= 1.")
            for gi, start in enumerate(range(0, n, every_n), start=1):
                group = list(range(start, min(start + every_n, n)))
                results.append({"data": _subset_bytes(doc, group),
                                "title": f"{base_title} — part {gi}"})
        elif mode == "by_size_mb":
            limit = max(0.05, float(max_mb)) * 1024 * 1024
            sizes = []
            for i in range(n):
                one = fitz.open()
                one.insert_pdf(doc, from_page=i, to_page=i)
                sizes.append(len(one.tobytes(garbage=1, deflate=True)))
                one.close()
            cur: list[int] = []
            cur_size = 0
            groups: list[list[int]] = []
            for i, s in enumerate(sizes):
                if cur and cur_size + s > limit:
                    groups.append(cur)
                    cur, cur_size = [], 0
                cur.append(i)
                cur_size += s
            if cur:
                groups.append(cur)
            for gi, group in enumerate(groups, start=1):
                results.append({"data": _subset_bytes(doc, group),
                                "title": f"{base_title} — part {gi}"})
        elif mode == "by_bookmarks":
            toc = doc.get_toc(simple=True)
            level1 = [(title, pg - 1) for lvl, title, pg in toc if lvl == 1]
            if not level1:
                raise InvalidParams("Document has no level-1 bookmarks to split on.")
            for gi, (title, start) in enumerate(level1):
                end = level1[gi + 1][1] if gi + 1 < len(level1) else n
                group = list(range(max(0, start), min(end, n)))
                if not group:
                    continue
                results.append({"data": _subset_bytes(doc, group),
                                "title": f"{base_title} — {title}"})
        else:
            raise InvalidParams(f"unknown split mode '{mode}'")
        if not results:
            raise InvalidParams("split produced no documents")
        return results
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Compression
# --------------------------------------------------------------------------- #
def _recompress_images(doc: fitz.Document, max_dim: int, quality: int, grayscale: bool) -> None:
    from PIL import Image

    seen: set[int] = set()
    for pno in range(doc.page_count):
        page = doc[pno]
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in seen:
                continue
            seen.add(xref)
            base = doc.extract_image(xref)
            if not base:
                continue
            raw = base["image"]
            if base.get("smask"):
                # Soft-masked image: the mask is a separate xref and JPEG cannot
                # carry it, so recompressing would flatten the transparency.
                continue
            try:
                im = Image.open(io.BytesIO(raw))
                im.load()
            except Exception:  # noqa: BLE001
                continue
            if im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info:
                # Same reason: converting to RGB/L composites alpha onto black.
                continue
            target_mode = "L" if grayscale else "RGB"
            if im.mode != target_mode:
                # Pillow returns `Image`; the variable started life as the
                # `ImageFile` that `open()` gave us. Same object graph.
                im = im.convert(target_mode)  # type: ignore[assignment]
            w, h = im.size
            if max(w, h) > max_dim:
                ratio = max_dim / max(w, h)
                im = im.resize(  # type: ignore[assignment]
                    (max(1, int(w * ratio)), max(1, int(h * ratio))))
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=quality, optimize=True)
            new = buf.getvalue()
            if len(new) < len(raw):
                try:
                    page.replace_image(xref, stream=new)
                except Exception:  # noqa: BLE001
                    continue


def compress(data: bytes, *, preset: str = "balanced", image_dpi: int = 150) -> tuple[bytes, dict]:
    """Return (bytes, report). Report: {before, after, ratio, note?} (§10)."""
    before = len(data)
    doc = _open(data)
    try:
        if preset == "light":
            pass
        elif preset == "balanced":
            _recompress_images(doc, max_dim=int(image_dpi * 11), quality=75, grayscale=False)
            try:
                doc.subset_fonts()
            except Exception:  # noqa: BLE001
                pass
        elif preset == "strong":
            dpi = min(image_dpi, 110)
            _recompress_images(doc, max_dim=int(dpi * 11), quality=55, grayscale=True)
            try:
                doc.subset_fonts()
            except Exception:  # noqa: BLE001
                pass
        else:
            raise InvalidParams(f"unknown compress preset '{preset}'")
        out = doc.tobytes(**_SAVE)
    finally:
        doc.close()

    after = len(out)
    if after >= before * 0.97:
        # <3% gain → report as already optimized, keep the original bytes.
        return data, {"before": before, "after": before, "ratio": 0.0,
                      "note": "already optimized"}
    return out, {"before": before, "after": after,
                 "ratio": round(1 - after / before, 4)}
