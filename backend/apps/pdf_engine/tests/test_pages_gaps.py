"""Page-operation guardrails `test_engine.py` does not exercise (phase-02; §10).

The golden file proves every operation does its job. This one proves every
operation *refuses* in the way the API contract promises — `InvalidParams`
or `PageOutOfRange`, never an `IndexError` out of PyMuPDF — and covers the
layouts and presets the golden file takes only one branch of: 4-up, a blank
page that inherits its size from its neighbour, inserting a whole document,
a merge whose second document has its own outline, and the compress presets
with their best-effort font subsetting patched to fail.
"""
from unittest import mock

import fitz
import pytest

from apps.pdf_engine.engine import pages as P
from apps.pdf_engine.exceptions import (
    DocumentEncryptedError,
    InvalidParams,
    PageOutOfRange,
    UnsupportedFileError,
)


def _open(data: bytes) -> fitz.Document:
    return fitz.open(stream=data, filetype="pdf")


def _count(data: bytes) -> int:
    doc = _open(data)
    try:
        return doc.page_count
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Opening
# --------------------------------------------------------------------------- #
def test_bytes_that_are_not_a_pdf_are_an_unsupported_file():
    with pytest.raises(UnsupportedFileError, match="Could not open"):
        P.rotate_pages(b"definitely not a pdf", pages=[0], degrees=90)


def test_an_encrypted_document_is_refused_before_any_edit(fixture_bytes):
    with pytest.raises(DocumentEncryptedError):
        P.delete_pages(fixture_bytes("encrypted.pdf"), pages=[0])


def test_an_empty_page_list_is_refused(fixture_bytes):
    with pytest.raises(InvalidParams, match="non-empty"):
        P.rotate_pages(fixture_bytes("text.pdf"), pages=[], degrees=90)


def test_a_size_given_as_a_pair_is_used_verbatim(fixture_bytes):
    out = P.insert_blank(fixture_bytes("text.pdf"), at_index=0, size=(300, 150))
    doc = _open(out)
    try:
        assert (doc[0].rect.width, doc[0].rect.height) == (300, 150)
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# insert_blank
# --------------------------------------------------------------------------- #
def test_a_blank_page_cannot_be_inserted_past_the_end(fixture_bytes):
    with pytest.raises(PageOutOfRange, match="at_index 9"):
        P.insert_blank(fixture_bytes("text.pdf"), at_index=9)


def test_a_blank_page_can_be_appended_at_exactly_the_end(fixture_bytes):
    assert _count(P.insert_blank(fixture_bytes("text.pdf"), at_index=3)) == 4


def test_inserting_zero_blank_pages_is_refused(fixture_bytes):
    with pytest.raises(InvalidParams, match="count"):
        P.insert_blank(fixture_bytes("text.pdf"), at_index=0, count=0)


def test_match_previous_takes_the_size_of_the_page_before(fixture_bytes):
    tall = P.insert_blank(fixture_bytes("text.pdf"), at_index=1, size=(200, 900))
    out = P.insert_blank(tall, at_index=2, size="match-previous")
    doc = _open(out)
    try:
        assert (doc[2].rect.width, doc[2].rect.height) == (200, 900)
        assert doc[3].rect.width == pytest.approx(595, abs=1), "the old page 2 moved"
    finally:
        doc.close()


def test_match_previous_at_the_front_falls_back_to_a4(fixture_bytes):
    tall = P.insert_blank(fixture_bytes("text.pdf"), at_index=0, size=(200, 900))
    out = P.insert_blank(tall, at_index=0, size="match-previous")
    doc = _open(out)
    try:
        assert (round(doc[0].rect.width), round(doc[0].rect.height)) == (595, 842)
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# insert_from_document
# --------------------------------------------------------------------------- #
def test_inserting_a_document_past_the_end_is_refused(fixture_bytes):
    with pytest.raises(PageOutOfRange, match="at_index 4"):
        P.insert_from_document(fixture_bytes("text.pdf"), fixture_bytes("unicode.pdf"),
                               source_pages=[0], at_index=4)


def test_a_source_page_that_does_not_exist_is_refused(fixture_bytes):
    with pytest.raises(PageOutOfRange, match="source page 7"):
        P.insert_from_document(fixture_bytes("text.pdf"), fixture_bytes("unicode.pdf"),
                               source_pages=[7], at_index=0)


def test_no_source_pages_means_the_whole_document(fixture_bytes):
    out = P.insert_from_document(fixture_bytes("text.pdf"), fixture_bytes("text.pdf"),
                                 source_pages=None, at_index=3)
    assert _count(out) == 6


# --------------------------------------------------------------------------- #
# nup
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("per_sheet", [1, 3, 6])
def test_only_two_and_four_up_are_offered(fixture_bytes, per_sheet):
    with pytest.raises(InvalidParams, match="per_sheet"):
        P.nup(fixture_bytes("text.pdf"), per_sheet=per_sheet)


def test_four_up_is_a_portrait_sheet_in_a_two_by_two_grid(fixture_bytes):
    out = P.nup(fixture_bytes("text.pdf"), per_sheet=4)
    doc = _open(out)
    try:
        assert doc.page_count == 1  # ceil(3/4)
        sheet = doc[0]
        assert sheet.rect.width < sheet.rect.height, "4-up should be portrait"
        # Three source pages: top-left, top-right, bottom-left are inked; the
        # bottom-right cell is empty.
        pix = sheet.get_pixmap(dpi=36)
        w, h = pix.width, pix.height

        def inked(x0, y0, x1, y1):
            return any(pix.pixel(x, y) != (255, 255, 255)
                       for y in range(y0, y1, 3) for x in range(x0, x1, 3))

        assert inked(0, 0, w // 2, h // 2)
        assert inked(w // 2, 0, w, h // 2)
        assert inked(0, h // 2, w // 2, h)
        assert not inked(w // 2, h // 2, w, h)
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# merge
# --------------------------------------------------------------------------- #
def test_a_merged_outline_is_offset_by_the_pages_before_it(fixture_bytes):
    """The second document's own bookmarks must point at its pages *in the
    merged file*, nested one level under its title entry."""
    doc = _open(fixture_bytes("text.pdf"))
    doc.set_toc([[1, "Chapter", 1], [2, "Section", 2]])
    with_outline = doc.tobytes()
    doc.close()

    out = P.merge([fixture_bytes("text.pdf"), with_outline], titles=["A", "B"])
    doc = _open(out)
    try:
        toc = doc.get_toc(simple=True)
    finally:
        doc.close()
    assert toc == [[1, "A", 1], [1, "B", 4], [2, "Chapter", 4], [3, "Section", 5]]


# --------------------------------------------------------------------------- #
# split
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("ranges,message", [
    ("2-9", "invalid range '2-9'"),
    ("0", "invalid range '0'"),
    ("3-1", "invalid range '3-1'"),
])
def test_a_range_outside_the_document_is_named_in_the_refusal(fixture_bytes, ranges, message):
    with pytest.raises(InvalidParams, match=message):
        P.split(fixture_bytes("text.pdf"), mode="ranges", ranges=ranges)


def test_a_range_spec_with_nothing_in_it_is_refused(fixture_bytes):
    with pytest.raises(InvalidParams, match="no valid ranges"):
        P.split(fixture_bytes("text.pdf"), mode="ranges", ranges=" , ,")


def test_blank_parts_in_a_range_spec_are_skipped_not_fatal(fixture_bytes):
    parts = P.split(fixture_bytes("text.pdf"), mode="ranges", ranges="1,,3")
    assert len(parts) == 2


def test_every_n_below_one_is_refused(fixture_bytes):
    with pytest.raises(InvalidParams, match="every_n"):
        P.split(fixture_bytes("text.pdf"), mode="every_n", every_n=0)


def test_an_unknown_split_mode_is_refused(fixture_bytes):
    with pytest.raises(InvalidParams, match="unknown split mode 'shuffle'"):
        P.split(fixture_bytes("text.pdf"), mode="shuffle")


def test_two_bookmarks_on_the_same_page_yield_one_part(fixture_bytes):
    """A level-1 entry whose range is empty (the next entry starts on the same
    page) produces no document rather than an empty one."""
    doc = _open(fixture_bytes("text.pdf"))
    doc.set_toc([[1, "Cover", 1], [1, "Body", 1]])
    data = doc.tobytes()
    doc.close()
    parts = P.split(data, mode="by_bookmarks", base_title="D")
    assert [p["title"] for p in parts] == ["D — Body"]
    assert _count(parts[0]["data"]) == 3


def test_a_split_that_produces_nothing_says_so(fixture_bytes):
    with mock.patch.object(P, "_ranges_to_indices", return_value=[]):
        with pytest.raises(InvalidParams, match="produced no documents"):
            P.split(fixture_bytes("text.pdf"), mode="ranges", ranges="1")


# --------------------------------------------------------------------------- #
# compress
# --------------------------------------------------------------------------- #
def _image_heavy() -> bytes:
    """One large RGB image placed twice, so the xref de-dup path runs."""
    source = fitz.open()
    page = source.new_page(width=400, height=400)
    page.draw_rect(page.rect, color=None, fill=(1, 0, 0))
    png = page.get_pixmap().tobytes("png")
    source.close()

    doc = fitz.open()
    page = doc.new_page()
    xref = page.insert_image(fitz.Rect(0, 0, 150, 150), stream=png)
    page.insert_image(fitz.Rect(200, 200, 350, 350), xref=xref)
    try:
        return doc.tobytes()
    finally:
        doc.close()


def test_an_unknown_preset_is_refused(fixture_bytes):
    with pytest.raises(InvalidParams, match="unknown compress preset 'ultra'"):
        P.compress(fixture_bytes("text.pdf"), preset="ultra")


def test_balanced_recompresses_images_and_survives_a_font_subsetting_failure():
    """Font subsetting is best-effort; the image pass is the preset's job and
    must still have happened when subsetting throws."""
    data = _image_heavy()
    with mock.patch.object(fitz.Document, "subset_fonts",
                           side_effect=RuntimeError("no fonts")) as subset:
        out, report = P.compress(data, preset="balanced")
    subset.assert_called_once()
    assert report["ratio"] > 0.5, report
    doc = _open(out)
    try:
        info = doc.extract_image(doc[0].get_images(full=True)[0][0])
        assert info["ext"] in {"jpeg", "jpg"}
        assert info["colorspace"] == 3, "balanced must keep colour"
    finally:
        doc.close()


def test_strong_goes_grey_and_survives_a_font_subsetting_failure():
    data = _image_heavy()
    with mock.patch.object(fitz.Document, "subset_fonts",
                           side_effect=RuntimeError("no fonts")):
        out, report = P.compress(data, preset="strong")
    assert report["ratio"] > 0.5, report
    doc = _open(out)
    try:
        info = doc.extract_image(doc[0].get_images(full=True)[0][0])
        assert info["colorspace"] == 1, "strong should have gone greyscale"
    finally:
        doc.close()


def test_an_image_that_will_not_be_replaced_is_skipped_not_fatal():
    data = _image_heavy()
    with mock.patch.object(fitz.Page, "replace_image",
                           side_effect=RuntimeError("locked")):
        out, _report = P.compress(data, preset="balanced")
    doc = _open(out)
    try:
        info = doc.extract_image(doc[0].get_images(full=True)[0][0])
        assert info["ext"] == "png", "the image was replaced after all"
    finally:
        doc.close()


def test_an_image_pymupdf_cannot_extract_is_skipped_not_fatal():
    data = _image_heavy()
    with mock.patch.object(fitz.Document, "extract_image", return_value={}):
        out, _report = P.compress(data, preset="balanced")
    doc = _open(out)
    try:
        assert doc.extract_image(doc[0].get_images(full=True)[0][0])["ext"] == "png"
    finally:
        doc.close()


def test_an_image_pillow_cannot_decode_is_skipped_not_fatal():
    from PIL import Image

    data = _image_heavy()
    with mock.patch.object(Image, "open", side_effect=OSError("cannot identify image")):
        out, _report = P.compress(data, preset="strong")
    doc = _open(out)
    try:
        assert doc.extract_image(doc[0].get_images(full=True)[0][0])["ext"] == "png"
    finally:
        doc.close()
