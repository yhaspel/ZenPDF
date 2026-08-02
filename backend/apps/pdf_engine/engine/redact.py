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

import contextlib
import re

import fitz

from ..exceptions import EngineError, InvalidParams
from ..geometry import NormRect, apply_matrix_rect, norm_to_page_rect, page_rect_to_norm_clamped

# Presets are deliberately conservative: a pattern that also matches ordinary
# prose would redact a document into uselessness, and the user cannot see what
# it took until afterwards. Each one is unit-tested against near-misses.
PRESETS: dict[str, str] = {
    # 123-45-6789 — with the invalid area/group/serial blocks excluded, which is
    # what keeps it off ordinary hyphenated numbers.
    "ssn": r"\b(?!000|666|9\d\d)\d{3}[-\s](?!00)\d{2}[-\s](?!0000)\d{4}\b",
    "email": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    # A phone number is punctuated. The first version made every separator
    # optional, which made the pattern "any eight digits" — it ate an invoice
    # number, an order number and a part number off the fixture's own
    # "must survive" list. Three shapes only: an international `+CC` number, a
    # parenthesised area code, or a national 3–x–4 grouping. A four-digit first
    # group is not a phone number, and that single restriction is what keeps
    # `2026-000-1234` and `1234 5678 9012` out.
    "phone": (
        r"\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]\d{2,4}){1,3}"
        r"|\(\d{2,5}\)[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b"
        r"|\b\d{3}[\s.-]\d{3,4}[\s.-]\d{4}\b"
    ),
    # 13–19 digits in the usual groupings; the Luhn check is applied afterwards
    # so an invoice number that happens to look like a card is left alone. The
    # match may start too early (a row number in front of the card), so the
    # Luhn check retries on shorter suffixes rather than giving up — see
    # `_accepted_span`.
    "credit_card": r"\b(?:\d[ -]?){12,18}\d\b",
    # Printed in groups of four as often as not, so the spaces are part of the
    # pattern; the alphanumeric length is checked afterwards.
    "iban": r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}\b",
}

MAX_MATCHES = 5000

# A user-supplied regex is arbitrary code as far as the matcher is concerned:
# `(a+)+#` against 40 characters is minutes of CPU, and this op runs on a queue
# with two workers. The whole match phase runs under a wall-clock deadline.
PATTERN_DEADLINE_SECONDS = 20


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


@contextlib.contextmanager
def _deadline(seconds: int | None = None):
    """Wall-clock limit on pattern matching.

    A user-supplied regex is arbitrary work: `(a+)+#` against forty characters
    of text the same user also supplied is minutes of CPU, and one request per
    guest session would hold both `heavy` workers until the 900 s hard kill.
    `re` has no timeout of its own, so this is `SIGALRM` — available in the
    worker, where the task owns the main thread; a no-op anywhere else, which
    is the honest degradation (the caller is then a test or a thread).
    """
    import signal
    import threading

    seconds = PATTERN_DEADLINE_SECONDS if seconds is None else seconds
    usable = (
        hasattr(signal, "SIGALRM")
        and threading.current_thread() is threading.main_thread()
    )
    if not usable:  # pragma: no cover - platform/thread dependent
        yield
        return

    def _fire(_signum, _frame):
        raise EngineError(
            "That pattern took too long to run. Simplify it — nested repeats "
            "like `(a+)+` can take effectively forever.",
            code="validation_error",
        )

    previous = signal.signal(signal.SIGALRM, _fire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text)


# The lengths cards are actually issued in — 13 (old Visa), 14 (Diners),
# 15 (Amex), 16 (most), 19 (some Visa/Maestro). Anything else that happens to
# pass Luhn is a number, not a card.
CARD_LENGTHS = frozenset({13, 14, 15, 16, 19})


def _card_ok(digits: str) -> bool:
    return len(digits) in CARD_LENGTHS and _luhn(digits)


def _accepted_span(preset: str, match: re.Match) -> tuple[int, int] | None:
    """The part of `match` that really is what the preset is for, or None.

    Post-filters a regex cannot express cheaply — and, for card numbers, a
    *narrowing*: `Row 12 4111 1111 1111 1111` matches greedily from the row
    number, fails Luhn on eighteen digits, and the whole card would then be
    skipped. Trimming from the left and re-checking finds it.
    """
    text = match.group(0)
    if preset == "credit_card":
        if _card_ok(_digits(text)):
            return match.start(), match.end()
        # Narrowing, deliberately timid. Trying every starting offset finds a
        # Luhn-valid suffix of a long digit run about one time in ten — and a
        # false positive here deletes an order number for ever. So: only start
        # at a group boundary, and only when what is dropped is short enough to
        # be a row or line number rather than another number in its own right.
        for index in range(1, len(text)):
            if text[index - 1] not in " -" or not text[index].isdigit():
                continue
            dropped = _digits(text[:index])
            if len(dropped) > 3:
                break
            if _card_ok(_digits(text[index:])):
                return match.start() + index, match.end()
        return None
    if preset == "iban":
        # IBANs are 15–34 alphanumerics; the regex cannot count them once the
        # optional spaces are in it.
        body = re.sub(r"\s", "", text)
        return (match.start(), match.end()) if 15 <= len(body) <= 34 else None
    return match.start(), match.end()


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
        span = _accepted_span(preset, match) if preset else match.span()
        if span is None:
            continue
        start, end = span
        if start == end:
            continue
        # Every word the match touches contributes its rect; a match spanning a
        # line break therefore produces one rect per line, which is what has to
        # be blacked out.
        boxes = [rect for (ws, we, rect) in spans if ws < end and we > start]
        text = haystack[start:end]
        for box in _merge_by_line(boxes):
            found.append((box, text))
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
    """The pages to search. An empty `scope` means all of them; a *wrong* one
    is an error.

    Dropping out-of-range indices and falling back to "all pages" is the one
    failure this operation must not have: a stale page list from a client would
    turn a one-page redaction into a whole-document one, irreversibly.
    """
    if not scope:
        return list(range(doc.page_count))
    pages = []
    for value in scope:
        try:
            index = int(value)
        except (TypeError, ValueError) as exc:
            raise InvalidParams(f"invalid page {value!r}") from exc
        if not 0 <= index < doc.page_count:
            raise InvalidParams(
                f"page {index} is out of range (0..{doc.page_count - 1})"
            )
        pages.append(index)
    return pages


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
        matches: list[dict] = []
        with _deadline():
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
    # `None` means "no review list"; an **empty** list means "the user unticked
    # every match", which is not the same thing. Reading `if only` conflated
    # them, so unticking everything redacted everything.
    keep = None if only is None else set(only)

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

        pages = _pages_in_scope(doc, scope)
        counted = 0
        # What the verification pass is entitled to still find: everything the
        # user *kept*, counted per (page, text). Without this, the plan's own
        # flow — find three, untick one, apply two — reported the one the user
        # deliberately kept as "still findable", which reads as a failure.
        expected: dict[tuple[int, str], int] = {}
        removed_annots = 0
        with _deadline():
            for index in pages:
                page = doc[index]
                for pattern, preset in compiled:
                    for rect, text in _line_matches(page, pattern, preset=preset,
                                                    match_case=match_case):
                        identifier = f"p{index}:{counted}"
                        counted += 1
                        if keep is not None and identifier not in keep:
                            expected[(index, text)] = expected.get((index, text), 0) + 1
                            continue
                        by_page.setdefault(index, []).append(rect)
                # A comment carries its text in the annotation, not in the page
                # content — `get_text("words")` never sees it, so redaction left
                # it in the file and the recheck could not see it either. It is
                # the same secret; it goes.
                if compiled:
                    removed_annots += _strip_matching_annots(
                        page, compiled, match_case=match_case,
                    )

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

    residual = (_verify(out, compiled, pages=pages, expected=expected,
                        match_case=match_case) if compiled else 0)
    return out, {
        "applied": applied,
        "areas": len(areas),
        "annotations": removed_annots,
        "verification": {"rechecked": bool(compiled), "residual_matches": residual},
    }


def _annot_text(annot) -> str:
    info = annot.info or {}
    return " ".join(str(info.get(key, "")) for key in ("content", "subject", "title"))


def _strip_matching_annots(page, compiled, *, match_case: bool) -> int:
    """Delete annotations whose own text contains one of the patterns."""
    doomed = []
    for annot in page.annots():
        text = _annot_text(annot)
        if not text.strip():
            continue
        for pattern, preset in compiled:
            probe = pattern
            if not match_case and not (pattern.flags & re.IGNORECASE):
                probe = re.compile(pattern.pattern, pattern.flags | re.IGNORECASE)
            match = probe.search(text)
            if match and (not preset or _accepted_span(preset, match)):
                doomed.append(annot)
                break
    for annot in doomed:
        page.delete_annot(annot)
    return len(doomed)


def _verify(data: bytes, compiled, *, pages, expected, match_case: bool) -> int:
    """Re-read the result and count what the same patterns *should not* find.

    Only the pages that were in scope, and only beyond what the user chose to
    keep — a page nobody asked to redact is not residue, and neither is a match
    that was deliberately unticked.
    """
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        residual = 0
        for index in pages:
            if index >= doc.page_count:  # pragma: no cover - defensive
                continue
            page = doc[index]
            still: dict[str, int] = {}
            for pattern, preset in compiled:
                for _rect, text in _line_matches(page, pattern, preset=preset,
                                                 match_case=match_case):
                    still[text] = still.get(text, 0) + 1
            for text, count in still.items():
                residual += max(0, count - expected.get((index, text), 0))
        return residual
    finally:
        doc.close()
