"""Signature engine edges `apps/esign/tests/test_self_sign.py` does not reach.

The e-sign suite proves placement, rotation and the pixel bomb. Left over are
the refusals a client can provoke on the way in — an image whose header reads
but whose body does not, a name too long to render, a placement list that is
empty or absurd, a rect with a key missing — and two paths with no API of
their own: a photograph with no alpha channel going through
`normalize_signature`, and `fit_text`'s last-resort baseline write on a
rotated page, which exists so that a date in a box drawn too thin is still
*somewhere* on the page instead of silently dropped.
"""
from unittest import mock

import fitz
import pytest

from apps.pdf_engine.engine import signatures as SG
from apps.pdf_engine.exceptions import InvalidParams
from apps.pdf_engine.geometry import apply_matrix_rect


def _ink(width=300, height=120) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    page.draw_line((40, 80), (260, 50), width=3)
    data = page.get_pixmap(alpha=True).tobytes("png")
    doc.close()
    return data


def _paper(width=120, height=60, *, fmt="png") -> bytes:
    """Ink on an opaque white background, as a phone camera would hand it over."""
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    page.draw_line((10, 30), (110, 30), width=4)
    data = page.get_pixmap(alpha=False).tobytes(fmt)
    doc.close()
    return data


def _blank_pdf(rotation: int = 0, width=300, height=200) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    page.set_rotation(rotation)
    try:
        return doc.tobytes()
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Images on the way in
# --------------------------------------------------------------------------- #
def test_a_jpeg_whose_header_reads_but_whose_body_does_not_is_refused():
    """The header guard passes it — 10×10 is a fine size — and the decoder is
    what finds out. That failure has to be the same `InvalidParams` as every
    other bad image, not a MuPDF exception escaping to a 500."""
    sof0 = (b"\xff\xd8\xff\xc0" + (17).to_bytes(2, "big") + b"\x08"
            + (10).to_bytes(2, "big") + (10).to_bytes(2, "big")
            + b"\x03\x01\x11\x00\x02\x11\x01\x03\x11\x01")
    with pytest.raises(InvalidParams, match="could not be read"):
        SG.png_size(sof0 + b"garbage" * 10)


def test_an_image_declaring_too_many_pixels_is_refused_without_decoding():
    side = 4000  # 16 MP, twice the ceiling, in a 33-byte file
    header = (b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR"
              + side.to_bytes(4, "big") + side.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00")
    with pytest.raises(InvalidParams, match="too large"):
        SG.png_size(header + b"\x00" * 8)


def test_the_decoded_size_is_checked_too_when_the_header_understates_it():
    """The header is a claim. If a decoder ever accepted a file whose real
    bitmap is larger than its header says, the second check is what stands
    between it and the worker."""
    side = 3000  # 9 MP decoded, over the 8 MP ceiling
    pixmap = fitz.Pixmap(fitz.csGRAY, fitz.IRect(0, 0, side, side))
    pixmap.set_rect(pixmap.irect, (255,))
    big = pixmap.tobytes("png")
    with mock.patch("apps.core.assets.header_dimensions", return_value=(10, 10)):
        with pytest.raises(InvalidParams, match="too large"):
            SG.png_size(big)


def test_a_jpeg_is_normalized_to_png_with_its_pixels():
    out = SG.to_png(_paper(fmt="jpg"))
    assert out[:8] == b"\x89PNG\r\n\x1a\n"
    assert SG.png_size(out) == (120, 60)


def test_a_png_is_returned_as_it_came():
    png = _ink()
    assert SG.to_png(png) is png


def test_a_photograph_without_alpha_has_its_paper_removed_by_normalize():
    """`trim_transparent` is a no-op on an opaque image, so without the
    background pass the paper itself would be stamped onto the contract."""
    out = SG.normalize_signature(_paper(fmt="jpg"))
    pixmap = fitz.Pixmap(out)
    assert pixmap.alpha, "the paper came through opaque"
    # Trimmed to the ink: the 4pt line at y=30 in a 60pt-high image.
    assert pixmap.height < 30, pixmap.height
    alphas = pixmap.samples[3::4]
    assert max(alphas) == 255 and min(alphas) == 0, "no transparency was added"


def test_a_fully_inked_canvas_needs_no_trim_and_is_returned_as_is():
    doc = fitz.open()
    page = doc.new_page(width=40, height=20)
    page.draw_rect(page.rect, color=(0, 0, 0), fill=(0, 0, 0))
    solid = page.get_pixmap(alpha=True).tobytes("png")
    doc.close()
    assert SG.trim_transparent(solid) is solid


def test_an_opaque_image_is_not_trimmed():
    paper = _paper()
    assert SG.trim_transparent(paper) is paper


# --------------------------------------------------------------------------- #
# Typed signatures
# --------------------------------------------------------------------------- #
def test_a_name_longer_than_a_hundred_characters_is_refused():
    with pytest.raises(InvalidParams, match="too long"):
        SG.render_typed("A" * 101)


def test_a_hundred_character_name_still_renders():
    png = SG.render_typed("A" * 100)
    assert SG.png_size(png)[0] > 1000


# --------------------------------------------------------------------------- #
# Placements
# --------------------------------------------------------------------------- #
def test_no_placements_means_nothing_to_sign(fixture_bytes):
    with pytest.raises(InvalidParams, match="Place the signature"):
        SG.self_sign(fixture_bytes("text.pdf"), placements=[], images={"s": _ink()})
    with pytest.raises(InvalidParams, match="Place the signature"):
        SG.self_sign(fixture_bytes("text.pdf"), placements=None, images={"s": _ink()})


def test_more_placements_than_the_ceiling_are_refused_before_opening(fixture_bytes):
    placement = {"page": 0, "signature_id": "s",
                 "rect": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1}}
    with pytest.raises(InvalidParams, match=f"At most {SG.MAX_PLACEMENTS}"):
        SG.self_sign(fixture_bytes("text.pdf"),
                     placements=[placement] * (SG.MAX_PLACEMENTS + 1),
                     images={"s": _ink()})


def test_exactly_the_ceiling_is_allowed(fixture_bytes):
    placement = {"page": 0, "signature_id": "s",
                 "rect": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1}}
    out = SG.self_sign(fixture_bytes("text.pdf"),
                       placements=[placement] * SG.MAX_PLACEMENTS,
                       images={"s": _ink()})
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert len(doc[0].get_images()) >= 1
    finally:
        doc.close()


@pytest.mark.parametrize("rect", [
    {"x": 0.1, "y": 0.1, "w": 0.2},          # missing h
    {"x": "left", "y": 0.1, "w": 0.2, "h": 0.1},
    None,
])
def test_a_malformed_rect_is_a_validation_error_not_a_crash(fixture_bytes, rect):
    with pytest.raises(InvalidParams, match="invalid rect"):
        SG.self_sign(fixture_bytes("text.pdf"),
                     placements=[{"page": 0, "signature_id": "s", "rect": rect}],
                     images={"s": _ink()})


# --------------------------------------------------------------------------- #
# fit_text's last resort
# --------------------------------------------------------------------------- #
def _displayed_words(page) -> list[tuple[str, tuple[float, float, float, float]]]:
    rot = tuple(page.rotation_matrix)
    return [(w[4], apply_matrix_rect(w[0], w[1], w[2], w[3], rot))
            for w in page.get_text("words")]


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_text_that_fits_no_size_is_still_written_at_the_displayed_corner(rotation):
    """A date in a box drawn too thin must not vanish. The fallback writes it
    at 4pt from the *displayed* bottom-left of the box, which on a rotated page
    is a different corner of the unrotated rect — get that wrong and the text
    lands somewhere else on the page, or off it."""
    doc = fitz.open(stream=_blank_pdf(rotation), filetype="pdf")
    try:
        page = doc[0]
        box = fitz.Rect(20, 20, 26, 26)  # 6pt square in display space
        rect = fitz.Rect(*SG._derotate(page, box))

        size = SG.fit_text(page, rect, "2026-10-14", max_size=9)
        assert size == 4

        words = _displayed_words(page)
        assert [w for w, _ in words] == ["2026-10-14"]
        x0, y0, x1, y1 = words[0][1]
        # Starts at the box's displayed left edge, sits on its bottom edge,
        # and reads along the displayed horizontal.
        assert abs(x0 - box.x0) < 1, (rotation, words)
        assert abs(y1 - box.y1) < 2, (rotation, words)
        assert x1 - x0 > y1 - y0, (rotation, words)
    finally:
        doc.close()


def test_text_that_fits_is_written_at_the_largest_size_that_does():
    doc = fitz.open(stream=_blank_pdf(), filetype="pdf")
    try:
        page = doc[0]
        size = SG.fit_text(page, fitz.Rect(20, 20, 200, 40), "2026-10-14", max_size=9)
        assert size == 9
        assert [w for w, _ in _displayed_words(page)] == ["2026-10-14"]
    finally:
        doc.close()
