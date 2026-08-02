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
from apps.pdf_engine.exceptions import InvalidParams


def _text(data: bytes) -> str:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return "\n".join(page.get_text() for page in doc)
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
    ("credit_card", "4111 1111 1111 1111"),
    ("credit_card", "5500-0000-0000-0004"),
    ("iban", "GB33BUKB20201555555555"),
    ("iban", "DE89370400440532013000"),
])
def test_each_preset_catches_what_it_is_for(preset, hit):
    pattern = R.compile_pattern("preset", preset)
    match = pattern.search(hit)
    assert match, f"{preset} missed {hit!r}"
    assert R._accepts(preset, match.group(0)), f"{preset} post-filter rejected {hit!r}"


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
])
def test_each_preset_leaves_the_near_misses_alone(preset, miss):
    """A pattern that also matches ordinary prose redacts a document into
    uselessness, and the user cannot see what it took until afterwards."""
    pattern = R.compile_pattern("preset", miss and preset)
    match = pattern.search(miss)
    assert not (match and R._accepts(preset, match.group(0))), \
        f"{preset} wrongly matched {miss!r}"


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
    assert report["count"] == 2, report
    found = {m["text"] for m in report["matches"]}
    assert "dana.cohen@example.com" in found
    assert "r.levi@mail.example.co.uk" in found
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
    assert b"dana.cohen" in original or "dana.cohen" in _text(original)

    out, report = R.redact(original,
                           patterns=[{"kind": "preset", "value": "email"}])
    assert report["applied"] == 2, report
    assert report["verification"] == {"rechecked": True, "residual_matches": 0}

    text = _text(out)
    assert "dana.cohen@example.com" not in text
    assert "r.levi@mail.example.co.uk" not in text
    # The bytes, not just the extraction: this is the whole difference from
    # whiteout, which leaves the string in the file for anyone to copy out.
    assert b"dana.cohen" not in out
    assert b"r.levi" not in out
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
    assert b"Secret sentence" not in out


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
    assert found["count"] == 2
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
    for i in range(3):
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
