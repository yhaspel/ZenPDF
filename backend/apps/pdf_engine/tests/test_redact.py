"""Golden tests for redaction (phase-07; §8, §18).

The claim this module makes is stronger than any other in the product: that the
content is *gone*. So the assertions go past extraction and into the raw bytes —
a redaction that survives `get_text` but leaves the string in the file is not a
redaction, it is a whiteout with a better name.
"""
import re

import fitz
import pytest

from apps.pdf_engine.engine import redact as R
from apps.pdf_engine.exceptions import EngineError, InvalidParams


def _text(data: bytes) -> str:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()


def raw_text_bytes(data: bytes) -> bytes:
    """Everything the file's content streams would draw, decompressed.

    A plain `b"secret" in pdf_bytes` grep is **vacuous** on anything PyMuPDF
    writes: it emits text as hex strings (`<64616e61…>`) inside deflated
    streams, so the literal never appears and the assertion passes whether or
    not the content was removed. This decodes both spellings, which is what
    "irrecoverable" has to be measured against.
    """
    import binascii
    import re as _re

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        chunks = []
        for page in doc:
            contents = page.read_contents()
            chunks.append(contents)
            for hex_literal in _re.findall(rb"<([0-9A-Fa-f\s]+)>", contents):
                cleaned = _re.sub(rb"\s", b"", hex_literal)
                if len(cleaned) % 2:
                    cleaned = cleaned[:-1]
                try:
                    chunks.append(binascii.unhexlify(cleaned))
                except binascii.Error:
                    continue
        return b"".join(chunks)
    finally:
        doc.close()


def _doc_with(*lines: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    for i, line in enumerate(lines):
        page.insert_text((60, 100 + i * 24), line, fontsize=12)
    try:
        return doc.tobytes()
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# The preset patterns, one table (phase-07 §Tests)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("preset,hit", [
    ("ssn", "123-45-6789"),
    ("ssn", "123 45 6789"),
    ("email", "dana.cohen@example.com"),
    ("email", "r.levi@mail.example.co.uk"),
    ("email", "a+tag@sub.domain.org"),
    ("phone", "+44 20 7946 0958"),
    ("phone", "(020) 7946 0958"),
    ("phone", "555-123-4567"),
    ("phone", "555 123 4567"),
    ("phone", "+1 (415) 555 0132"),
    ("credit_card", "4111 1111 1111 1111"),
    ("credit_card", "5500-0000-0000-0004"),
    # The card is found even when a row number runs into it: the greedy match
    # starts too early, fails Luhn on eighteen digits, and the narrowing retry
    # is what stops the whole card being skipped.
    ("credit_card", "12 4111 1111 1111 1111"),
    ("iban", "GB33BUKB20201555555555"),
    ("iban", "DE89370400440532013000"),
    # Printed the way banks print it, which is how it arrives in a document.
    ("iban", "DE89 3704 0044 0532 0130 00"),
    ("iban", "GB33 BUKB 2020 1555 5555 55"),
])
def test_each_preset_catches_what_it_is_for(preset, hit):
    pattern = R.compile_pattern("preset", preset)
    match = pattern.search(hit)
    assert match, f"{preset} missed {hit!r}"
    assert R._accepted_span(preset, match), f"{preset} post-filter rejected {hit!r}"


@pytest.mark.parametrize("preset,miss", [
    # Invalid SSN blocks — the ranges the administration never issues.
    ("ssn", "000-45-6789"),
    ("ssn", "666-45-6789"),
    ("ssn", "900-45-6789"),
    ("ssn", "123-00-6789"),
    ("ssn", "123-45-0000"),
    ("email", "not an email at all"),
    ("email", "missing@tld"),
    # Right shape, wrong checksum: an order number is not a card.
    ("credit_card", "1234 5678 9012 3456"),
    ("credit_card", "1234 5678 9012 3456 7"),
    ("iban", "HELLO WORLD"),
    # The reason the phone pattern is shaped the way it is. Every one of these
    # was matched by the first version, which made every separator optional and
    # so meant "any eight digits" — it ate three lines off the fixture's own
    # "must survive" list.
    ("phone", "Invoice 2026-000-1234"),
    ("phone", "Order number 1234 5678 9012 3456 7"),
    ("phone", "Part no. 40213599"),
    ("phone", "Account 12345678"),
    ("phone", "ISBN 978-3-16-148410-0"),
    ("phone", "IBAN: GB33BUKB20201555555555"),
    ("phone", "Card on file: 4111 1111 1111 1111"),
])
def test_each_preset_leaves_the_near_misses_alone(preset, miss):
    """A pattern that also matches ordinary prose redacts a document into
    uselessness, and the user cannot see what it took until afterwards."""
    pattern = R.compile_pattern("preset", miss and preset)
    match = pattern.search(miss)
    assert not (match and R._accepted_span(preset, match)), \
        f"{preset} wrongly matched {miss!r}: {match.group(0) if match else None!r}"


def test_an_unknown_preset_is_named(fixture_bytes):
    with pytest.raises(InvalidParams, match="Unknown preset"):
        R.compile_pattern("preset", "passport")


def test_a_broken_regex_is_a_validation_error():
    with pytest.raises(InvalidParams, match="not a valid pattern"):
        R.compile_pattern("regex", "([unclosed")


# --------------------------------------------------------------------------- #
# Finding
# --------------------------------------------------------------------------- #
def test_the_dry_run_finds_the_fixture_pii(fixture_bytes):
    report = R.find_matches(fixture_bytes("pii.pdf"),
                            patterns=[{"kind": "preset", "value": "email"}])
    assert report["dry_run"] is True
    assert report["count"] == 3, report
    found = {m["text"] for m in report["matches"]}
    assert "dana.cohen@example.com" in found
    assert "r.levi@mail.example.co.uk" in found
    assert "sam.parker@example.org" in found
    for match in report["matches"]:
        rect = match["rect"]
        assert 0 <= rect["x"] <= 1 and 0 <= rect["y"] <= 1


def test_a_multi_word_pattern_is_found_across_the_words(fixture_bytes):
    """A phone number written `+44 20 7946 0958` is four "words"; searching one
    word at a time would find none of it."""
    report = R.find_matches(fixture_bytes("pii.pdf"),
                            patterns=[{"kind": "preset", "value": "phone"}])
    assert report["count"] >= 1
    assert any("7946" in m["text"] for m in report["matches"])


def test_the_order_number_that_looks_like_a_card_is_not_matched(fixture_bytes):
    report = R.find_matches(fixture_bytes("pii.pdf"),
                            patterns=[{"kind": "preset", "value": "credit_card"}])
    texts = " ".join(m["text"] for m in report["matches"])
    assert "4111" in texts, "the real card was missed"
    assert "1234 5678 9012 3456 7" not in texts, "an order number was matched"


def test_finding_needs_something_to_look_for(fixture_bytes):
    with pytest.raises(InvalidParams, match="pattern or some text"):
        R.find_matches(fixture_bytes("pii.pdf"))


# --------------------------------------------------------------------------- #
# Removing
# --------------------------------------------------------------------------- #
def test_pattern_redaction_removes_the_content_irrecoverably(fixture_bytes):
    """Acceptance criterion, both halves: extraction *and* a raw-bytes grep."""
    original = fixture_bytes("pii.pdf")
    assert b"dana.cohen" in raw_text_bytes(original), "the fixture never had it"

    out, report = R.redact(original,
                           patterns=[{"kind": "preset", "value": "email"}])
    assert report["applied"] == 3, report
    assert report["verification"] == {"rechecked": True, "residual_matches": 0}

    text = _text(out)
    assert "dana.cohen@example.com" not in text
    assert "r.levi@mail.example.co.uk" not in text
    assert "sam.parker@example.org" not in text
    # The bytes, not just the extraction: this is the whole difference from
    # whiteout, which leaves the string in the file for anyone to copy out.
    raw = raw_text_bytes(out)
    assert b"dana.cohen" not in raw
    assert b"r.levi" not in raw
    # …and the rest of the page is untouched.
    assert "Client record" in text
    assert "Invoice 2026-000-1234" in text


def test_area_redaction_removes_the_glyphs_under_it():
    data = _doc_with("Secret sentence here", "Public sentence here")
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        page = doc[0]
        hit = page.search_for("Secret sentence here")[0]
        rect = {
            "x": (hit.x0 - 2) / page.rect.width,
            "y": (hit.y0 - 2) / page.rect.height,
            "w": (hit.width + 4) / page.rect.width,
            "h": (hit.height + 4) / page.rect.height,
        }
    finally:
        doc.close()

    out, report = R.redact(data, areas=[{"page": 0, "rect": rect}])
    assert report["areas"] == 1
    text = _text(out)
    assert "Secret sentence" not in text
    assert "Public sentence here" in text
    assert b"Secret sentence" not in raw_text_bytes(out)


def test_redacting_over_an_image_destroys_the_pixels(fixture_bytes):
    """Acceptance criterion: "blacks out image content, not just overlay".

    Asserted by rendering: a covered photograph and a destroyed one look the
    same in a viewer, so the test opens the *image* the file still contains.
    """
    original = fixture_bytes("redact-image.pdf")

    def image_colours(data: bytes) -> set:
        doc = fitz.open(stream=data, filetype="pdf")
        try:
            colours = set()
            for xref, *_ in doc[0].get_images(full=True):
                pix = fitz.Pixmap(doc, xref)
                if pix.n > 3:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                for x in range(0, pix.width, max(1, pix.width // 8)):
                    for y in range(0, pix.height, max(1, pix.height // 8)):
                        colours.add(pix.pixel(x, y))
            return colours
        finally:
            doc.close()

    before = image_colours(original)
    assert any(c[0] > 150 and c[1] < 100 for c in before), "the fixture is not red"

    out, _ = R.redact(original, areas=[{"page": 0, "rect":
                                        {"x": 0.1, "y": 0.15, "w": 0.8, "h": 0.75}}])
    after = image_colours(out)
    assert not any(c[0] > 150 and c[1] < 100 for c in after), \
        f"the photograph survived the redaction: {after}"


def test_only_applies_the_matches_that_were_kept(fixture_bytes):
    """The review list's unticked rows are how a user says "not that one" —
    and the count applied must equal the count kept, not the count found."""
    found = R.find_matches(fixture_bytes("pii.pdf"),
                           patterns=[{"kind": "preset", "value": "email"}])
    assert found["count"] == 3
    keep = [found["matches"][0]["id"]]

    out, report = R.redact(fixture_bytes("pii.pdf"),
                           patterns=[{"kind": "preset", "value": "email"}],
                           only=keep)
    assert report["applied"] == 1
    text = _text(out)
    assert "dana.cohen@example.com" not in text
    assert "r.levi@mail.example.co.uk" in text, "an unticked match was redacted"


def test_the_dry_run_count_equals_what_gets_applied(fixture_bytes):
    """phase-07 §Tests: "dry-run counts = applied count"."""
    patterns = [{"kind": "preset", "value": "email"},
                {"kind": "preset", "value": "ssn"}]
    found = R.find_matches(fixture_bytes("pii.pdf"), patterns=patterns)
    _out, report = R.redact(fixture_bytes("pii.pdf"), patterns=patterns)
    assert report["applied"] == found["count"]


def test_plain_search_text_is_redacted(fixture_bytes):
    out, report = R.redact(fixture_bytes("pii.pdf"), search_text="Client record")
    assert report["applied"] >= 1
    assert "Client record" not in _text(out)


def test_the_label_is_drawn_over_the_box():
    data = _doc_with("Confidential paragraph")
    out, _ = R.redact(data, search_text="Confidential",
                      fill={"color": "#000000", "label": "REDACTED"})
    assert "Confidential" not in _text(out)
    assert "REDACTED" in _text(out)


def test_scope_limits_which_pages_are_touched():
    doc = fitz.open()
    for _ in range(3):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 100), "secret@example.com", fontsize=12)
    data = doc.tobytes()
    doc.close()

    out, report = R.redact(data, patterns=[{"kind": "preset", "value": "email"}],
                           scope=[1])
    assert report["applied"] == 1
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert "secret@example.com" in doc[0].get_text()
        assert "secret@example.com" not in doc[1].get_text()
        assert "secret@example.com" in doc[2].get_text()
    finally:
        doc.close()


def test_redaction_needs_something_to_remove(fixture_bytes):
    with pytest.raises(InvalidParams, match="Nothing to redact"):
        R.redact(fixture_bytes("pii.pdf"))


def test_the_verification_pass_reports_what_it_still_finds(fixture_bytes):
    """Not decoration: text drawn as curves is invisible to a pattern search,
    and the honest answer to "is it gone?" is a re-read, not an assumption."""
    _out, report = R.redact(fixture_bytes("pii.pdf"),
                            patterns=[{"kind": "preset", "value": "ssn"}])
    assert report["verification"]["rechecked"] is True
    assert report["verification"]["residual_matches"] == 0


def test_an_area_redaction_alone_does_not_claim_a_pattern_recheck():
    data = _doc_with("Nothing to see")
    _out, report = R.redact(data, areas=[{"page": 0, "rect":
                                          {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05}}])
    assert report["verification"] == {"rechecked": False, "residual_matches": 0}


def test_redaction_on_a_rotated_page_lands_on_the_text(fixture_bytes):
    """§8: `get_text("words")` answers unrotated, `page.rect` is the displayed
    box. Mixing them puts the black bar a quarter-turn from the words."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 100), "secret@example.com", fontsize=14)
    page.insert_text((60, 140), "keep@example.org", fontsize=14)
    doc[0].set_rotation(90)
    data = doc.tobytes()
    doc.close()

    out, report = R.redact(data, search_text="secret@example.com")
    assert report["applied"] == 1
    text = _text(out)
    assert "secret@example.com" not in text
    assert "keep@example.org" in text


def test_a_match_is_matched_case_insensitively_when_asked():
    data = _doc_with("Contact DANA@EXAMPLE.COM today")
    out, report = R.redact(data, search_text="dana@example.com", match_case=False)
    assert report["applied"] == 1
    assert "DANA@EXAMPLE.COM" not in _text(out)


def test_a_regex_pattern_works_end_to_end():
    data = _doc_with("Case number ABC-9981 filed")
    out, report = R.redact(data, patterns=[{"kind": "regex",
                                            "value": r"[A-Z]{3}-\d{4}"}])
    assert report["applied"] == 1
    assert not re.search(r"[A-Z]{3}-\d{4}", _text(out))


# --------------------------------------------------------------------------- #
# What the review list means (self-review, four lenses)
# --------------------------------------------------------------------------- #
def test_unticking_every_match_removes_nothing(fixture_bytes):
    """`only: []` is the user saying "none of these".

    It read as "no filter at all", so unticking every row in the review list
    redacted every row instead — the exact inversion of what the user asked
    for, on an operation that cannot be undone.
    """
    out, report = R.redact(fixture_bytes("pii.pdf"),
                           patterns=[{"kind": "preset", "value": "email"}],
                           only=[])
    assert report["applied"] == 0
    assert "dana.cohen@example.com" in _text(out)


def test_an_unticked_match_is_not_reported_as_residue(fixture_bytes):
    """The phase's own flow: find three, untick one, apply two.

    The recheck used to re-run every pattern over every page and count what it
    found, so the match the user deliberately kept came back as "still
    findable" — which the UI shows as a red failure on a correct redaction.
    """
    found = R.find_matches(fixture_bytes("pii.pdf"),
                           patterns=[{"kind": "preset", "value": "email"}])
    keep = [m["id"] for m in found["matches"][:2]]

    out, report = R.redact(fixture_bytes("pii.pdf"),
                           patterns=[{"kind": "preset", "value": "email"}],
                           only=keep)
    assert report["applied"] == 2
    assert report["verification"] == {"rechecked": True, "residual_matches": 0}
    # …and the third one really is still there, which is what was asked for.
    assert "sam.parker@example.org" in _text(out)


def test_a_page_outside_the_scope_is_not_residue():
    data = _doc_with("dana@example.com")
    doc = fitz.open(stream=data, filetype="pdf")
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 100), "other@example.com", fontsize=12)
    data = doc.tobytes()
    doc.close()

    _out, report = R.redact(data, patterns=[{"kind": "preset", "value": "email"}],
                            scope=[0])
    assert report["applied"] == 1
    assert report["verification"]["residual_matches"] == 0


def test_a_scope_that_names_no_real_page_is_an_error():
    """Silently falling back to "every page" turned a one-page redaction into a
    whole-document one, irreversibly."""
    data = _doc_with("dana@example.com")
    with pytest.raises(InvalidParams, match="out of range"):
        R.redact(data, patterns=[{"kind": "preset", "value": "email"}], scope=[9])


def test_a_comment_carrying_the_same_secret_goes_too():
    """`get_text("words")` never sees annotation text, so a note containing the
    address survived the redaction *and* the recheck said zero."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 100), "Contact dana@example.com", fontsize=12)
    annot = page.add_text_annot((300, 300), "chase dana@example.com about it")
    annot.update()
    data = doc.tobytes()
    doc.close()

    out, report = R.redact(data, patterns=[{"kind": "preset", "value": "email"}])
    assert report["annotations"] == 1
    assert b"dana@example.com" not in raw_text_bytes(out)

    after = fitz.open(stream=out, filetype="pdf")
    try:
        assert not list(after[0].annots()), "the note survived"
    finally:
        after.close()


def test_a_runaway_pattern_is_stopped_rather_than_running_for_ever(monkeypatch):
    """`(a+)+#` is minutes of CPU on forty characters, on a queue with two
    workers. `re` has no timeout, so the match phase runs under an alarm."""
    # One second rather than the production twenty — the point is that the
    # alarm fires, and a test that takes 20 s to prove it is its own problem.
    monkeypatch.setattr(R, "PATTERN_DEADLINE_SECONDS", 1)
    data = _doc_with("a" * 46)
    with pytest.raises(EngineError, match="took too long"):
        R.find_matches(data, patterns=[{"kind": "regex", "value": "(a+)+#"}])
