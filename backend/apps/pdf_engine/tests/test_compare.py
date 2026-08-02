"""Golden tests for document compare (phase-06; §8, §18)."""
import fitz
import pytest

from apps.pdf_engine.engine import compare as C
from apps.pdf_engine.exceptions import InvalidParams


def _kinds(report, page=0):
    return [c["kind"] for c in report["pages"][page]["text_changes"]]


def test_a_document_compared_with_itself_is_identical(fixture_bytes):
    data = fixture_bytes("compare-a.pdf")
    report = C.compare(data, data)
    assert report["summary"]["identical"] is True
    assert report["summary"]["text_changes"] == 0
    assert all(not p["visual_regions"] for p in report["pages"])


def test_the_crafted_pair_reports_the_injected_change(fixture_bytes):
    """phase-06 §Tests: "compare of fixture vs edited-fixture finds the injected
    change"."""
    report = C.compare(fixture_bytes("compare-a.pdf"), fixture_bytes("compare-b.pdf"))
    assert report["summary"]["identical"] is False

    inserted = [c for c in report["pages"][0]["text_changes"] if c["kind"] == "insert"]
    assert inserted, "the added line was not reported"
    assert "extra line" in " ".join(c["b_text"] for c in inserted)

    # And it points at where to look, on the side that has it.
    rect = inserted[0]["b_rect"]
    assert rect and 0 <= rect["x"] <= 1 and 0 <= rect["y"] <= 1
    assert inserted[0]["a_rect"] is None


def test_the_visual_pass_sees_a_change_the_text_diff_cannot(fixture_bytes):
    """phase-06 §Tests: "visual diff flags the stamped region". Page 2 differs
    only by a black box — the words are identical, so a text-only compare would
    call the page unchanged."""
    report = C.compare(fixture_bytes("compare-a.pdf"), fixture_bytes("compare-b.pdf"))
    page_two = report["pages"][1]
    assert page_two["text_changes"] == []
    assert page_two["visual_regions"], "the stamped box was not flagged"

    # The region is roughly where the box is: x 200–420 of 595, y 300–420 of 842.
    region = max(page_two["visual_regions"], key=lambda r: r["w"] * r["h"])
    assert 0.25 <= region["x"] <= 0.40
    assert 0.30 <= region["y"] <= 0.42


def test_the_visual_pass_can_be_turned_off(fixture_bytes):
    report = C.compare(fixture_bytes("compare-a.pdf"), fixture_bytes("compare-b.pdf"),
                       visual=False)
    assert all(not p["visual_regions"] for p in report["pages"])
    # The text half still works.
    assert report["summary"]["text_changes"] > 0


def test_a_replaced_word_is_reported_with_both_sides():
    def doc_with(text: str) -> bytes:
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 100), text, fontsize=14)
        try:
            return doc.tobytes()
        finally:
            doc.close()

    report = C.compare(doc_with("Total is twelve pounds"),
                       doc_with("Total is thirty pounds"))
    change = next(c for c in report["pages"][0]["text_changes"] if c["kind"] == "replace")
    assert change["a_text"] == "twelve"
    assert change["b_text"] == "thirty"
    assert change["a_rect"] and change["b_rect"]


def test_an_extra_page_is_a_change_not_a_silent_omission(fixture_bytes):
    """"Page 7 was added" is exactly what a reader is comparing to find."""
    short = fixture_bytes("compare-a.pdf")
    doc = fitz.open(stream=short, filetype="pdf")
    try:
        doc.new_page(width=595, height=842)
        longer = doc.tobytes()
    finally:
        doc.close()

    report = C.compare(short, longer)
    assert len(report["pages"]) == 3
    assert report["pages"][2]["a_page"] is None
    assert report["pages"][2]["b_page"] == 2
    assert _kinds(report, 2) == ["insert"]


def test_the_offset_aligns_pages_that_moved(fixture_bytes):
    """phase-06 v1 alignment: index-based, with a manual offset. A cover page
    added to B shifts everything by one, and without the offset every page
    compares against the wrong one."""
    data = fixture_bytes("compare-a.pdf")
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        cover = doc.new_page(0, width=595, height=842)
        cover.insert_text((72, 100), "Cover", fontsize=30)
        shifted = doc.tobytes()
    finally:
        doc.close()

    misaligned = C.compare(data, shifted)
    aligned = C.compare(data, shifted, offset=1)
    assert aligned["summary"]["text_changes"] < misaligned["summary"]["text_changes"]
    # With the offset, page 0 of A is compared against page 1 of B — and B's
    # new page 0 is reported on its own, because "a page was added" is a change.
    pair = next(p for p in aligned["pages"] if p["a_page"] == 0)
    assert pair["b_page"] == 1
    assert any(p["a_page"] is None and p["b_page"] == 0 for p in aligned["pages"])


def test_a_silly_offset_is_a_validation_error(fixture_bytes):
    with pytest.raises(InvalidParams):
        C.compare(fixture_bytes("compare-a.pdf"), fixture_bytes("compare-b.pdf"),
                  offset="lots")


def test_a_document_beyond_the_page_ceiling_is_refused(fixture_bytes, monkeypatch):
    """Compare renders every page of both documents; without a ceiling a pair of
    long files is a way to spend a worker for minutes at a time."""
    monkeypatch.setattr(C, "MAX_PAGES", 1)
    data = fixture_bytes("compare-a.pdf")  # 2 pages
    with pytest.raises(InvalidParams, match="up to"):
        C.compare(data, data)


def test_a_cover_page_added_to_b_is_still_compared():
    """The offset's own use case. `b_index = index + offset`, so the loop has to
    *start* at -offset; starting at 0 threw away the first `offset` pages of B —
    the cover page the offset exists to align — and then reported "identical"."""
    def doc_with(*lines: str) -> bytes:
        doc = fitz.open()
        for line in lines:
            page = doc.new_page(width=595, height=842)
            page.insert_text((72, 100), line, fontsize=14)
        try:
            return doc.tobytes()
        finally:
            doc.close()

    a = doc_with("body")
    b = doc_with("COVER", "body")

    report = C.compare(a, b, offset=1, visual=False)
    covered = [p["b_page"] for p in report["pages"] if p["b_page"] is not None]
    assert 0 in covered, f"B page 0 was never compared: {covered}"
    assert report["summary"]["identical"] is False
    inserted = [c for page in report["pages"] for c in page["text_changes"]]
    assert any("COVER" in c["b_text"] for c in inserted)


def test_a_text_change_on_a_rotated_page_is_reported_where_it_is_seen(fixture_bytes):
    """§8: `get_text("words")` answers in *unrotated* space while `page.rect` is
    the displayed box. Dividing one by the other put the highlight most of a
    page-width from the word — and made the two panes disagree, since the visual
    pass renders in display space and was right."""
    def rotated(text: str) -> bytes:
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 100), text, fontsize=14)
        doc[0].set_rotation(90)
        try:
            return doc.tobytes()
        finally:
            doc.close()

    report = C.compare(rotated("Total is twelve pounds"),
                       rotated("Total is thirty pounds"), visual=False)
    change = next(c for c in report["pages"][0]["text_changes"]
                  if c["kind"] == "replace")
    # On a page rotated 90°, text written near the top-left of the unrotated
    # page is displayed near the *right* edge.
    assert change["a_rect"]["x"] > 0.5, change["a_rect"]
    assert 0 <= change["a_rect"]["y"] <= 1


def test_pages_of_different_sizes_are_compared_whole():
    """Rendering at a fixed zoom and comparing the overlapping corner missed
    everything outside it — half a page, if one side is wider — and mis-scaled
    the regions it did find."""
    def page_with_box(width: float, box) -> bytes:
        doc = fitz.open()
        page = doc.new_page(width=width, height=842)
        if box:
            page.draw_rect(fitz.Rect(*box), color=None, fill=(0, 0, 0))
        try:
            return doc.tobytes()
        finally:
            doc.close()

    # The box is only in A, and it sits beyond B's right-hand edge.
    a = page_with_box(1190, (700, 300, 1100, 700))
    b = page_with_box(595, None)
    report = C.compare(a, b)
    assert report["pages"][0]["visual_regions"], "the box outside the overlap was missed"
    assert report["summary"]["identical"] is False


def test_a_small_stamp_does_not_produce_a_report_that_contradicts_itself():
    """A page with a change listed must not be summarised as identical."""
    def with_stamp(stamped: bool) -> bytes:
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 100), "Invoice", fontsize=14)
        if stamped:
            page.draw_rect(fitz.Rect(300, 300, 360, 360), color=None, fill=(0, 0, 0))
        try:
            return doc.tobytes()
        finally:
            doc.close()

    report = C.compare(with_stamp(False), with_stamp(True))
    page = report["pages"][0]
    assert page["visual_regions"], "the stamp was not found at all"
    assert report["summary"]["identical"] is False, "the summary contradicts the list"
    assert report["summary"]["changed_pages"] == 1
