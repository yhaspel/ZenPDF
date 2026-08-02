"""Redaction (phase-07; §8, §10).

The distinction this module exists to make good on: Phase 4's whiteout *hides*
content — a white box over text that anyone can still copy out — and the editor
says so in those words. Redaction **removes** it. `apply_redactions()` deletes
the glyphs from the content stream and, by default, the pixels of any image the
rectangle touches, so what comes out has no text to find and no picture to
recover.

Two ways to say what goes:

* **areas** — rectangles drawn on the page, which is the only thing that works
  on a scan or on text that was converted to outlines;
* **patterns** — a preset (SSN, email, phone, card number, IBAN), a regex, or a
  plain search, matched against the page's own words.

Patterns find *text*. Text drawn as curves, and text inside an image, are
invisible to them — which is exactly why the UI points at area redaction for
anything scanned, and why every job re-extracts afterwards and reports what it
still finds.
"""
from __future__ import annotations

import re

import fitz

from ..exceptions import InvalidParams
from ..geometry import NormRect, apply_matrix_rect, norm_to_page_rect, page_rect_to_norm_clamped

# Presets are deliberately conservative: a pattern that also matches ordinary
# prose would redact a document into uselessness, and the user cannot see what
# it took until afterwards. Each one is unit-tested against near-misses.
PRESETS: dict[str, str] = {
    # 123-45-6789 — with the invalid area/group/serial blocks excluded, which is
    # what keeps it off ordinary hyphenated numbers.
    "ssn": r"\b(?!000|666|9\d\d)\d{3}[-\s](?!00)\d{2}[-\s](?!0000)\d{4}\b",
    "email": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    # Long enough to be a phone number, with the separators people actually use.
    "phone": r"(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b",
    # 13–19 digits in the usual groupings; the Luhn check is applied afterwards
    # so an invoice number that happens to look like a card is left alone.
    "credit_card": r"\b(?:\d[ -]?){12,18}\d\b",
    "iban": r"\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b",
}

MAX_MATCHES = 5000


def _luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def compile_pattern(kind: str, value: str) -> re.Pattern:
    if kind == "preset":
        if value not in PRESETS:
            raise InvalidParams(f"Unknown preset '{value}'. Choose one of "
                                f"{sorted(PRESETS)}.")
        return re.compile(PRESETS[value])
    if kind == "regex":
        try:
            return re.compile(value)
        except re.error as exc:
            raise InvalidParams(f"That is not a valid pattern: {exc}") from exc
    raise InvalidParams("`kind` must be 'preset' or 'regex'.")


def _accepts(preset: str, text: str) -> bool:
    """Post-filters that a regex cannot express cheaply."""
    if preset == "credit_card":
        digits = re.sub(r"\D", "", text)
        return 13 <= len(digits) <= 19 and _luhn(digits)
    return True


def _page_words(page):
    """Words with their rects, in reading order, in *display* space (§8).

    `get_text("words")` answers in the page's unrotated space, so every rect is
    rotated here — once — and everything downstream is display space.
    """
    rot = tuple(page.rotation_matrix)
    words = sorted(page.get_text("words"), key=lambda w: (w[5], w[6], w[7]))
    out = []
    for x0, y0, x1, y1, word, *_rest in words:
        out.append((fitz.Rect(x0, y0, x1, y1), word, rot))
    return out


def _line_matches(page, pattern: re.Pattern, *, preset: str = "",
                  match_case: bool = True) -> list[tuple[fitz.Rect, str]]:
    """Rects of every match, found over the page's reconstructed text.

    Reconstructed line by line rather than word by word: an email address is
    one word, but a phone number written `+44 20 7946 0958` is four, and a
    word-at-a-time search would find none of it.
    """
    words = _page_words(page)
    if not words:
        return []

    text_parts: list[str] = []
    spans: list[tuple[int, int, fitz.Rect]] = []
    cursor = 0
    for rect, word, _rot in words:
        if text_parts:
            text_parts.append(" ")
            cursor += 1
        text_parts.append(word)
        spans.append((cursor, cursor + len(word), rect))
        cursor += len(word)
    haystack = "".join(text_parts)

    flags = 0 if match_case else re.IGNORECASE
    if flags and not (pattern.flags & re.IGNORECASE):
        pattern = re.compile(pattern.pattern, pattern.flags | re.IGNORECASE)

    found: list[tuple[fitz.Rect, str]] = []
    for match in pattern.finditer(haystack):
        start, end = match.span()
        if start == end:
            continue
        if preset and not _accepts(preset, match.group(0)):
            continue
        # Every word the match touches contributes its rect; a match spanning a
        # line break therefore produces one rect per line, which is what has to
        # be blacked out.
        boxes = [rect for (ws, we, rect) in spans if ws < end and we > start]
        for box in _merge_by_line(boxes):
            found.append((box, match.group(0)))
        if len(found) >= MAX_MATCHES:
            break
    return found


def _merge_by_line(boxes: list[fitz.Rect]) -> list[fitz.Rect]:
    """One rect per visual line, so a wrapped match is two bars, not a block."""
    if not boxes:
        return []
    merged: list[fitz.Rect] = []
    for box in boxes:
        for i, existing in enumerate(merged):
            # Same line when the vertical centres are within half a line height.
            if abs((existing.y0 + existing.y1) / 2 - (box.y0 + box.y1) / 2) \
                    < max(existing.height, box.height) * 0.6:
                merged[i] = existing | box
                break
        else:
            merged.append(fitz.Rect(box))
    return merged


def _norm(rect: fitz.Rect, page) -> dict:
    x0, y0, x1, y1 = apply_matrix_rect(rect.x0, rect.y0, rect.x1, rect.y1,
                                       tuple(page.rotation_matrix))
    nr = page_rect_to_norm_clamped(x0, y0, x1, y1,
                                   page.rect.width, page.rect.height)
    return {"x": round(nr.x, 6), "y": round(nr.y, 6),
            "w": round(nr.w, 6), "h": round(nr.h, 6)}


def _raw_rect(value, page) -> fitz.Rect:
    """A §8 normalized rect → the page's *unrotated* space, where annotations
    live (§8's per-API table)."""
    try:
        norm = NormRect.from_dict(value)
    except ValueError as exc:
        raise InvalidParams(f"invalid rect: {exc}") from exc
    x0, y0, x1, y1 = norm_to_page_rect(norm, page.rect.width, page.rect.height)
    x0, y0, x1, y1 = apply_matrix_rect(x0, y0, x1, y1,
                                       tuple(page.derotation_matrix))
    return fitz.Rect(x0, y0, x1, y1)


def _pages_in_scope(doc, scope) -> list[int]:
    if not scope:
        return list(range(doc.page_count))
    pages = []
    for value in scope:
        try:
            index = int(value)
        except (TypeError, ValueError) as exc:
            raise InvalidParams(f"invalid page {value!r}") from exc
        if 0 <= index < doc.page_count:
            pages.append(index)
    return pages or list(range(doc.page_count))


def find_matches(data: bytes, *, patterns=None, search_text: str = "",
                 match_case: bool = True, scope=None) -> dict:
    """The dry run: what *would* be redacted, for the review list."""
    compiled = []
    for spec in patterns or []:
        kind = (spec or {}).get("kind", "preset")
        value = (spec or {}).get("value", "")
        compiled.append((compile_pattern(kind, value),
                         value if kind == "preset" else ""))
    if search_text:
        compiled.append((re.compile(re.escape(search_text)), ""))
    if not compiled:
        raise InvalidParams("Give a pattern or some text to search for.")

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        matches = []
        for index in _pages_in_scope(doc, scope):
            page = doc[index]
            for pattern, preset in compiled:
                for rect, text in _line_matches(page, pattern, preset=preset,
                                                match_case=match_case):
                    matches.append({
                        "id": f"p{index}:{len(matches)}",
                        "page": index,
                        "rect": _norm(rect, page),
                        "text": text[:120],
                    })
        return {"count": len(matches), "matches": matches, "dry_run": True}
    finally:
        doc.close()


def redact(data: bytes, *, areas=None, patterns=None, search_text: str = "",
           match_case: bool = True, scope=None, fill=None, only=None) -> tuple[bytes, dict]:
    """Remove content. Returns (bytes, report).

    The report carries a **verification**: after applying, the document is
    re-read and the same patterns are run again. Residue is not expected — but
    "not expected" is not the same as "checked", and this is the one operation
    where the difference matters to somebody.
    """
    areas = areas or []
    fill = fill or {}
    if not areas and not patterns and not search_text:
        raise InvalidParams("Nothing to redact: give an area, a pattern or some text.")

    from ..colors import parse_color

    colour = parse_color(fill.get("color") or "#000000") or (0, 0, 0)
    label = str(fill.get("label") or "")
    keep = set(only) if only else None

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        compiled = []
        for spec in patterns or []:
            kind = (spec or {}).get("kind", "preset")
            value = (spec or {}).get("value", "")
            compiled.append((compile_pattern(kind, value),
                             value if kind == "preset" else ""))
        if search_text:
            compiled.append((re.compile(re.escape(search_text)), ""))

        by_page: dict[int, list[fitz.Rect]] = {}
        for area in areas:
            index = int(area.get("page", 0))
            if not 0 <= index < doc.page_count:
                raise InvalidParams(f"page {index} is out of range")
            by_page.setdefault(index, []).append(_raw_rect(area.get("rect"), doc[index]))

        counted = 0
        for index in _pages_in_scope(doc, scope):
            page = doc[index]
            for pattern, preset in compiled:
                for rect, _text in _line_matches(page, pattern, preset=preset,
                                                 match_case=match_case):
                    identifier = f"p{index}:{counted}"
                    counted += 1
                    if keep is not None and identifier not in keep:
                        continue
                    by_page.setdefault(index, []).append(rect)

        applied = 0
        for index, rects in by_page.items():
            page = doc[index]
            for rect in rects:
                page.add_redact_annot(rect, text=label or None,
                                      fill=colour, text_color=(1, 1, 1),
                                      fontsize=8)
                applied += 1
            # `images=PDF_REDACT_IMAGE_PIXELS` is the default and is the whole
            # difference from whiteout: the pixels under the box are destroyed,
            # not covered. Without it a redacted photograph is recoverable by
            # anyone who opens the file in an editor.
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)

        out = doc.tobytes(garbage=4, deflate=True, clean=True)
    finally:
        doc.close()

    residual = _verify(out, compiled, match_case=match_case) if compiled else 0
    return out, {
        "applied": applied,
        "areas": len(areas),
        "verification": {"rechecked": bool(compiled), "residual_matches": residual},
    }


def _verify(data: bytes, compiled, *, match_case: bool) -> int:
    """Re-read the result and count what the same patterns still find."""
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        residual = 0
        for index in range(doc.page_count):
            page = doc[index]
            for pattern, preset in compiled:
                residual += len(_line_matches(page, pattern, preset=preset,
                                              match_case=match_case))
        return residual
    finally:
        doc.close()
