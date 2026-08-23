"""`find_envelope_code` — including the repair for envelopes sealed before
2026-08-23 (§8's rotated-page class).

The repair matters because those files **cannot** be fixed at the source:
re-stamping a completed envelope changes bytes the PAdES seal covers and
invalidates the `final_sha256` printed on a certificate its signers already
hold. So `/verify` has to be able to read what was written badly.
"""
import fitz
import pytest

from apps.pdf_engine.engine import seal as SEAL


def _clean_footer(code: str = "ZEN-8F3KQ2", rotation: int = 0) -> bytes:
    """A footer written the way the fixed `stamp_envelope_footer` writes one."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.set_rotation(rotation)
    from apps.pdf_engine.engine.signatures import stamp_envelope_footer
    data = doc.tobytes()
    doc.close()
    return stamp_envelope_footer(data, code=code, verify_url="http://x/verify")


def _fragmented_footer(code: str = "ZEN-8F3KQ2") -> bytes:
    """A footer as the *old* code produced it on a /Rotate 90 page.

    Written by hand rather than by calling the old function, because the old
    function is gone: this pins the shape of the artefact, which is what is
    actually out there in already-sealed files.
    """
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.set_rotation(90)
    # The de-rotated display band: ~12pt wide, ~560pt tall, laid out
    # horizontally, so every line holds two or three characters.
    page.insert_textbox(fitz.Rect(578, 24, 590, 584),
                        f"Envelope {code} · verify at http://x/verify",
                        fontsize=7, fontname="helv")
    data = doc.tobytes()
    doc.close()
    return data


def test_the_fragmented_footer_really_is_fragmented():
    """The premise of the repair, asserted rather than assumed."""
    doc = fitz.open(stream=_fragmented_footer(), filetype="pdf")
    try:
        text = doc[0].get_text()
    finally:
        doc.close()
    assert "ZEN-8F3KQ2" not in text, "the fixture stopped reproducing the defect"
    assert "\n" in text


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_a_freshly_stamped_footer_is_found_at_every_rotation(rotation):
    assert SEAL.find_envelope_code(_clean_footer(rotation=rotation)) == "ZEN-8F3KQ2"


def test_an_envelope_sealed_before_the_fix_is_still_recognised():
    """The repair. Without it `/verify` says "not one of ours" about a document
    we sealed, for every envelope completed on a rotated page."""
    assert SEAL.find_envelope_code(_fragmented_footer()) == "ZEN-8F3KQ2"


def test_a_clean_code_anywhere_beats_a_fragmented_one():
    """Precedence, because the fallback is looser and must never pre-empt.

    Page 1 carries a fragmented code, page 2 a clean one; the clean one wins
    even though it is found later.
    """
    doc = fitz.open(stream=_fragmented_footer("ZEN-AAAAAA"), filetype="pdf")
    try:
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 800), "Envelope ZEN-BBBBBB · verify at http://x",
                         fontsize=7)
        mixed = doc.tobytes()
    finally:
        doc.close()
    assert SEAL.find_envelope_code(mixed) == "ZEN-BBBBBB"


def test_a_document_with_no_envelope_code_answers_empty():
    doc = fitz.open()
    doc.new_page()
    data = doc.tobytes()
    doc.close()
    assert SEAL.find_envelope_code(data) == ""
