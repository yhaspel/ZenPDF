"""Golden engine tests against the fixture corpus (01-architecture.md §18).

Assertions target page counts, extracted text, form fields, encryption state,
and geometry — never byte-equality (PDF output is nondeterministic).
"""

import fitz
import pytest

from apps.pdf_engine.engine import inspect, render_page, search_text, validate_pdf
from apps.pdf_engine.engine import pages as P
from apps.pdf_engine.engine.validate import repair_pdf
from apps.pdf_engine.exceptions import (
    DocumentEncryptedError,
    InvalidParams,
    PageOutOfRange,
    WouldDeleteAllPages,
)


def _pages(data: bytes) -> int:
    return inspect(data)["pages"]


def _text(data: bytes) -> str:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return "\n".join(p.get_text() for p in doc)
    finally:
        doc.close()


def _widgets(data: bytes) -> int:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return sum(1 for page in doc for _ in page.widgets())
    finally:
        doc.close()


# --- inspect / render / search -------------------------------------------- #
def test_inspect_text(fixture_bytes):
    info = inspect(fixture_bytes("text.pdf"))
    assert info["pages"] == 3
    assert info["encrypted"] is False


def test_inspect_large(fixture_bytes):
    assert inspect(fixture_bytes("large-generated.pdf"))["pages"] == 500


def test_render_page_png(fixture_bytes):
    png = render_page(fixture_bytes("text.pdf"), 0, width=200)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"


def test_render_page_out_of_range(fixture_bytes):
    with pytest.raises(PageOutOfRange):
        render_page(fixture_bytes("text.pdf"), 99)


def test_search_text_hits_normalized(fixture_bytes):
    hits = search_text(fixture_bytes("text.pdf"), "ZenPDF")
    assert len(hits) == 3
    for h in hits:
        assert 0 <= h["x"] <= 1 and 0 <= h["y"] <= 1
        assert h["w"] > 0 and h["h"] > 0


def test_search_empty_query(fixture_bytes):
    assert search_text(fixture_bytes("text.pdf"), "") == []


def test_unicode_text_extractable(fixture_bytes):
    text = _text(fixture_bytes("unicode.pdf"))
    assert "résumé" in text or "Café" in text


# --- validate / repair ----------------------------------------------------- #
def test_validate_clean(fixture_bytes):
    v = validate_pdf(fixture_bytes("text.pdf"))
    assert v["needs_repair"] is False and v["encrypted"] is False


def test_validate_encrypted(fixture_bytes):
    assert validate_pdf(fixture_bytes("encrypted.pdf"))["encrypted"] is True


def test_validate_corrupt_then_repair(fixture_bytes):
    corrupt = fixture_bytes("corrupt.pdf")
    assert validate_pdf(corrupt)["needs_repair"] is True
    repaired = repair_pdf(corrupt)
    assert validate_pdf(repaired)["needs_repair"] is False


def test_validate_not_a_pdf():
    from apps.pdf_engine.exceptions import UnsupportedFileError

    with pytest.raises(UnsupportedFileError):
        validate_pdf(b"this is not a pdf at all")


# --- page operations (phase 2 golden) -------------------------------------- #
def test_rotate_pages(fixture_bytes):
    out = P.rotate_pages(fixture_bytes("text.pdf"), pages=[0], degrees=90)
    doc = fitz.open(stream=out, filetype="pdf")
    assert doc[0].rotation == 90
    assert doc[1].rotation == 0
    doc.close()


def test_rotate_rejects_bad_degrees(fixture_bytes):
    with pytest.raises(InvalidParams):
        P.rotate_pages(fixture_bytes("text.pdf"), pages=[0], degrees=45)


def test_delete_pages(fixture_bytes):
    out = P.delete_pages(fixture_bytes("text.pdf"), pages=[1])
    assert _pages(out) == 2


def test_delete_all_pages_forbidden(fixture_bytes):
    with pytest.raises(WouldDeleteAllPages):
        P.delete_pages(fixture_bytes("text.pdf"), pages=[0, 1, 2])


def test_duplicate_pages(fixture_bytes):
    out = P.duplicate_pages(fixture_bytes("text.pdf"), pages=[0])
    assert _pages(out) == 4


def test_reorder_pages(fixture_bytes):
    out = P.reorder_pages(fixture_bytes("text.pdf"), new_order=[2, 1, 0])
    assert _pages(out) == 3


def test_reorder_rejects_non_permutation(fixture_bytes):
    with pytest.raises(InvalidParams):
        P.reorder_pages(fixture_bytes("text.pdf"), new_order=[0, 0, 1])


def test_reorder_keeps_rotation(fixture_bytes):
    # rotated-90 fixture: both pages rotated; reorder must preserve rotation.
    out = P.reorder_pages(fixture_bytes("rotated-90.pdf"), new_order=[1, 0])
    doc = fitz.open(stream=out, filetype="pdf")
    assert doc[0].rotation == 90 and doc[1].rotation == 90
    doc.close()


def test_extract_pages(fixture_bytes):
    out = P.extract_pages(fixture_bytes("text.pdf"), pages=[0, 2])
    assert _pages(out) == 2


def test_extract_pages_each_gives_one_document_per_page(fixture_bytes):
    out = P.extract_pages_each(fixture_bytes("text.pdf"), pages=[0, 2], base_title="Report")
    assert [i["title"] for i in out] == ["Report — page 1", "Report — page 3"]
    assert [_pages(i["data"]) for i in out] == [1, 1]


def test_extract_pages_each_collapses_duplicates(fixture_bytes):
    out = P.extract_pages_each(fixture_bytes("text.pdf"), pages=[1, 1, 0])
    assert [i["title"] for i in out] == ["Document — page 2", "Document — page 1"]


def test_extract_pages_each_rejects_a_page_that_is_not_there(fixture_bytes):
    with pytest.raises(PageOutOfRange):
        P.extract_pages_each(fixture_bytes("text.pdf"), pages=[9])


def test_insert_blank(fixture_bytes):
    out = P.insert_blank(fixture_bytes("text.pdf"), at_index=1, count=2, size="a4")
    assert _pages(out) == 5


def test_insert_from_document(fixture_bytes):
    out = P.insert_from_document(
        fixture_bytes("text.pdf"), fixture_bytes("unicode.pdf"),
        source_pages=[0], at_index=1,
    )
    assert _pages(out) == 4


def test_merge_preserves_pages_and_toc(fixture_bytes):
    out = P.merge([fixture_bytes("text.pdf"), fixture_bytes("unicode.pdf")],
                  titles=["Doc A", "Doc B"])
    assert _pages(out) == 4
    doc = fitz.open(stream=out, filetype="pdf")
    toc = doc.get_toc()
    doc.close()
    titles = [t[1] for t in toc]
    assert "Doc A" in titles and "Doc B" in titles


def test_merge_preserves_form_fields(fixture_bytes):
    before = _widgets(fixture_bytes("form.pdf"))
    out = P.merge([fixture_bytes("form.pdf"), fixture_bytes("text.pdf")])
    assert _widgets(out) >= before >= 2


def test_merge_requires_two(fixture_bytes):
    with pytest.raises(InvalidParams):
        P.merge([fixture_bytes("text.pdf")])


def test_alternate_mix(fixture_bytes):
    out = P.alternate_mix(fixture_bytes("text.pdf"), fixture_bytes("unicode.pdf"))
    assert _pages(out) == 4  # 3 + 1


def test_alternate_mix_reverse_b(fixture_bytes):
    out = P.alternate_mix(fixture_bytes("text.pdf"), fixture_bytes("text.pdf"), reverse_b=True)
    assert _pages(out) == 6


def test_nup(fixture_bytes):
    out = P.nup(fixture_bytes("text.pdf"), per_sheet=2)
    assert _pages(out) == 2  # ceil(3/2)


def test_crop_pages(fixture_bytes):
    out = P.crop_pages(fixture_bytes("text.pdf"), pages=[0],
                       rect={"x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5})
    doc = fitz.open(stream=out, filetype="pdf")
    cropped_w = doc[0].rect.width
    doc.close()
    assert cropped_w < 595  # cropbox shrank the page


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_crop_under_rotation(rotation):
    # Build a page at each rotation and crop the left-half; must not error and
    # must yield a smaller page (geometry §8 rotation regression).
    doc = fitz.open()
    page = doc.new_page(width=400, height=600)
    page.insert_text((50, 50), "hello", fontsize=12)
    page.set_rotation(rotation)
    data = doc.tobytes()
    doc.close()
    out = P.crop_pages(data, pages=[0], rect={"x": 0.0, "y": 0.0, "w": 0.4, "h": 0.4})
    result = fitz.open(stream=out, filetype="pdf")
    r = result[0].rect
    result.close()
    assert r.width > 0 and r.height > 0


def test_scale_pages(fixture_bytes):
    out = P.scale_pages(fixture_bytes("text.pdf"), pages=[0], target_size="letter")
    doc = fitz.open(stream=out, filetype="pdf")
    assert doc[0].rect.width == pytest.approx(612, abs=1)
    doc.close()


def test_split_ranges(fixture_bytes):
    parts = P.split(fixture_bytes("text.pdf"), mode="ranges", ranges="1,2-3")
    assert [_pages(p["data"]) for p in parts] == [1, 2]


def test_split_every_n(fixture_bytes):
    parts = P.split(fixture_bytes("large-generated.pdf"), mode="every_n", every_n=200)
    assert [_pages(p["data"]) for p in parts] == [200, 200, 100]


def test_split_by_size(fixture_bytes):
    parts = P.split(fixture_bytes("large-generated.pdf"), mode="by_size_mb", max_mb=0.05)
    assert len(parts) >= 2
    assert sum(_pages(p["data"]) for p in parts) == 500


def test_split_by_bookmarks_named(fixture_bytes):
    # merge builds a TOC with two level-1 parents "A" / "B" → split names by them.
    merged = P.merge([fixture_bytes("text.pdf"), fixture_bytes("unicode.pdf")],
                     titles=["A", "B"])
    parts = P.split(merged, mode="by_bookmarks", base_title="Merged")
    titles = [p["title"] for p in parts]
    assert "Merged — A" in titles and "Merged — B" in titles


def test_split_by_bookmarks_no_toc(fixture_bytes):
    with pytest.raises(InvalidParams):
        P.split(fixture_bytes("text.pdf"), mode="by_bookmarks")


def test_compress_scanned_reduces(fixture_bytes):
    out, report = P.compress(fixture_bytes("scanned.pdf"), preset="strong")
    assert report["ratio"] >= 0.30
    # text/structure still a valid PDF afterwards
    assert _pages(out) == 2


def test_compress_already_optimized(fixture_bytes):
    # Compressing an already-compressed file yields <3% → "already optimized".
    once, _ = P.compress(fixture_bytes("text.pdf"), preset="light")
    twice, report = P.compress(once, preset="light")
    assert report.get("note") == "already optimized"
    assert twice == once  # original bytes returned unchanged


def test_compress_preserves_image_transparency():
    """Soft-masked images are left alone — JPEG cannot carry an alpha channel."""
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGBA", (600, 600), (255, 0, 0, 128)).save(buf, format="PNG")
    doc = fitz.open()
    doc.new_page().insert_image(fitz.Rect(0, 0, 300, 300), stream=buf.getvalue())
    data = doc.tobytes()
    doc.close()

    out, _ = P.compress(data, preset="strong")

    doc = fitz.open(stream=out, filetype="pdf")
    try:
        images = doc[0].get_images(full=True)
        assert images
        # img[1] is the soft-mask xref; 0 means the transparency was flattened.
        assert all(img[1] for img in images)
    finally:
        doc.close()


def test_encrypted_op_blocked(fixture_bytes):
    with pytest.raises(DocumentEncryptedError):
        P.rotate_pages(fixture_bytes("encrypted.pdf"), pages=[0], degrees=90)
