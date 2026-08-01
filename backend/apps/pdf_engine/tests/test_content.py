"""Golden tests for the content-editing engine (phase-04; §8, §10, §18).

Structural and pixel assertions, never byte-equality.
"""
import fitz
import pytest

from apps.pdf_engine.engine import content as C
from apps.pdf_engine.exceptions import (
    DocumentEncryptedError,
    InvalidParams,
    PageOutOfRange,
)


def _text(data: bytes, page: int | None = None) -> str:
    """Extracted text, NFKC-normalized.

    Text drawn by `insert_htmlbox` is shaped, so "different" is stored as the
    ﬀ ligature and extracts as `diﬀerent`. That is ordinary PDF behaviour (any
    LaTeX or InDesign file does it) and is documented as a fidelity constraint;
    normalizing here keeps every other assertion about *content* honest instead
    of accidentally asserting a glyph choice. `test_inserted_text_uses_ligatures…`
    pins the real behaviour explicitly.
    """
    import unicodedata

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        pages = [doc[page]] if page is not None else list(doc)
        return unicodedata.normalize("NFKC", "\n".join(p.get_text() for p in pages))
    finally:
        doc.close()


def _blocks(data: bytes, page: int = 0) -> list[dict]:
    return C.text_blocks(data, page)["blocks"]


def _region_colors(data: bytes, page: int, clip) -> set:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        pm = doc[page].get_pixmap(clip=clip)
        return {pm.pixel(x, y)
                for y in range(0, pm.height, 3) for x in range(0, pm.width, 3)}
    finally:
        doc.close()


def _page_rect(data: bytes, page: int = 0):
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return fitz.Rect(doc[page].rect)
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Read models
# --------------------------------------------------------------------------- #
def test_text_blocks_reports_editable_blocks(fixture_bytes):
    model = C.text_blocks(fixture_bytes("text.pdf"), 0)
    assert model["page"] == 0
    assert model["is_scanned_page"] is False
    assert model["blocks"], "text.pdf must expose editable blocks"
    first = model["blocks"][0]
    assert "Sample document" in first["text"]
    assert 0 <= first["bbox"]["x"] <= 1
    span = first["lines"][0]["spans"][0]
    assert span["size"] > 0
    assert span["color"].startswith("#")


def test_a_scan_is_flagged_so_the_editor_can_refuse(fixture_bytes):
    """The gate phase-04 requires: a page of pixels has nothing to click."""
    model = C.text_blocks(fixture_bytes("scanned.pdf"), 0)
    assert model["is_scanned_page"] is True
    assert model["blocks"] == []


def test_text_blocks_out_of_range(fixture_bytes):
    with pytest.raises(PageOutOfRange):
        C.text_blocks(fixture_bytes("text.pdf"), 99)


def test_page_images_reports_xref_and_box(fixture_bytes):
    model = C.page_images(fixture_bytes("scanned.pdf"), 0)
    assert model["images"], "scanned.pdf is one big image"
    image = model["images"][0]
    assert image["xref"] > 0
    assert image["width"] > 0 and image["height"] > 0
    assert image["bbox"]["w"] > 0.5


def test_page_links_round_trip(fixture_bytes):
    out = C.add_link(fixture_bytes("text.pdf"), page=0,
                     rect={"x": 0.1, "y": 0.5, "w": 0.3, "h": 0.04},
                     kind="uri", uri="https://example.com/docs")
    links = C.page_links(out, 0)["links"]
    assert len(links) == 1
    assert links[0]["kind"] == "uri"
    assert links[0]["uri"] == "https://example.com/docs"
    assert links[0]["bbox"]["x"] == pytest.approx(0.1, abs=0.01)


# --------------------------------------------------------------------------- #
# edit_text
# --------------------------------------------------------------------------- #
def test_edit_text_replaces_a_block_and_leaves_its_neighbours(fixture_bytes):
    data = fixture_bytes("text.pdf")
    blocks = _blocks(data)
    target = blocks[0]
    neighbour_text = blocks[1]["text"]

    out = C.edit_text(data, edits=[{
        "page": 0, "block_bbox": target["bbox"],
        "new_text": "Completely different heading",
        "style": {"size": 20},
    }])
    text = _text(out, 0)
    assert "Completely different heading" in text
    assert "Sample document" not in text
    # The block next door is untouched — this is a block-scoped edit.
    assert neighbour_text.split("\n")[0] in text


def test_edit_text_keeps_other_pages_alone(fixture_bytes):
    data = fixture_bytes("text.pdf")
    out = C.edit_text(data, edits=[{
        "page": 0, "block_bbox": _blocks(data)[0]["bbox"], "new_text": "New",
    }])
    assert "Sample document · page 2" in _text(out, 1)


def test_edit_text_batches_two_blocks_on_one_page(fixture_bytes):
    """All redactions on a page are applied in one pass — doing it per-edit
    would invalidate the bboxes of the edits still queued."""
    data = fixture_bytes("text.pdf")
    blocks = _blocks(data)
    out = C.edit_text(data, edits=[
        {"page": 0, "block_bbox": blocks[0]["bbox"], "new_text": "First replaced"},
        {"page": 0, "block_bbox": blocks[1]["bbox"], "new_text": "Second replaced"},
    ])
    text = _text(out, 0)
    assert "First replaced" in text
    assert "Second replaced" in text


def test_edit_text_overflow_reports_the_size_that_would_fit(fixture_bytes):
    """The `text_overflow` contract: the UI needs a number to offer
    "shrink to N pt / enlarge the box / cancel"."""
    data = fixture_bytes("text.pdf")
    tiny = {"x": 0.1, "y": 0.1, "w": 0.12, "h": 0.02}
    with pytest.raises(C.TextOverflow) as exc:
        C.edit_text(data, edits=[{
            "page": 0, "block_bbox": tiny,
            "new_text": "far too much text to fit " * 40,
            "style": {"size": 18},
        }])
    assert exc.value.code == "text_overflow"
    fits = exc.value.details["fits_at_size"]
    assert 0 < fits < 18
    assert exc.value.details["requested_size"] == 18


def test_edit_text_unicode_and_rtl_survive(fixture_bytes):
    out = C.edit_text(fixture_bytes("hebrew-rtl.pdf"), edits=[{
        "page": 0, "block_bbox": {"x": 0.1, "y": 0.05, "w": 0.8, "h": 0.12},
        "new_text": "שלום עולם חדש",
    }])
    assert "שלום" in _text(out, 0)


def test_edit_text_escapes_markup_instead_of_rendering_it(fixture_bytes):
    """User text goes through `insert_htmlbox`; it must be content, not markup."""
    data = fixture_bytes("text.pdf")
    out = C.edit_text(data, edits=[{
        "page": 0, "block_bbox": _blocks(data)[0]["bbox"],
        "new_text": "<b>not bold</b> & <i>not italic</i>",
    }])
    text = _text(out, 0)
    assert "<b>not bold</b>" in text
    assert "& <i>not italic</i>" in text


def test_edit_text_keeps_the_file_from_ballooning(fixture_bytes):
    """`subset_fonts` before save — an edited file must not grow unreasonably.

    Measured on a realistically-sized document. Editing embeds a font, which is
    a fixed cost of roughly 10 KB; against the 2.9 KB `text.pdf` that alone is
    4x and says nothing about subsetting, so the 199 KB fixture is the honest
    subject for a ratio.
    """
    data = fixture_bytes("large-generated.pdf")
    out = C.edit_text(data, edits=[{
        "page": 0, "block_bbox": _blocks(data)[0]["bbox"], "new_text": "Short",
    }])
    assert len(out) < len(data) * 1.5, f"{len(data)} -> {len(out)}"


def test_inserted_text_uses_ligatures_and_search_still_finds_it(fixture_bytes):
    """Documents the fidelity constraint *and* the mitigation.

    `insert_htmlbox` shapes text, so "different" is stored as `di<ﬀ>erent` and a
    naive `search_for("different")` returns nothing — which would mean a user
    could not find the words they had just typed. `_search` looks for the
    ligature spellings too.
    """
    import unicodedata

    data = fixture_bytes("text.pdf")
    out = C.add_text(data, boxes=[{
        "page": 0, "rect": {"x": 0.1, "y": 0.6, "w": 0.6, "h": 0.06},
        "text": "different offer",
    }])
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        raw = doc[0].get_text()
        # The constraint: the stored glyphs are ligatures.
        assert "different offer" not in raw
        assert unicodedata.normalize("NFKC", raw).count("different offer") == 1
    finally:
        doc.close()

    # The mitigation: our own search finds it anyway.
    _, report = C.find_replace(out, find="different", dry_run=True)
    assert report["count"] == 1


@pytest.mark.parametrize("bad", [
    {"edits": []},
    {"edits": [{"page": 99, "block_bbox": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1},
                "new_text": "x"}]},
])
def test_edit_text_guardrails(fixture_bytes, bad):
    with pytest.raises((InvalidParams, PageOutOfRange)):
        C.edit_text(fixture_bytes("text.pdf"), **bad)


def test_edit_text_rejects_an_unknown_font(fixture_bytes):
    data = fixture_bytes("text.pdf")
    with pytest.raises(InvalidParams):
        C.edit_text(data, edits=[{
            "page": 0, "block_bbox": _blocks(data)[0]["bbox"], "new_text": "x",
            "style": {"font_family": "Comic Sans'; }; evil {"},
        }])


# --------------------------------------------------------------------------- #
# add_text / whiteout
# --------------------------------------------------------------------------- #
def test_add_text_puts_new_text_on_the_page(fixture_bytes):
    out = C.add_text(fixture_bytes("text.pdf"), boxes=[{
        "page": 1, "rect": {"x": 0.1, "y": 0.6, "w": 0.6, "h": 0.08},
        "text": "Added by the user", "style": {"size": 14},
    }])
    assert "Added by the user" in _text(out, 1)


def test_whiteout_covers_the_pixels_but_leaves_the_text_extractable(fixture_bytes):
    """The documented, deliberate difference from redaction — and the reason the
    UI copy has to say so, because a user who assumes otherwise leaks."""
    data = fixture_bytes("text.pdf")
    rect = _page_rect(data)
    clip = fitz.Rect(0.1 * rect.width, 0.09 * rect.height,
                     0.5 * rect.width, 0.13 * rect.height)
    assert any(sum(c) < 600 for c in _region_colors(data, 0, clip)), "ink expected"

    out = C.whiteout(data, rects=[{"page": 0,
                                   "rect": {"x": 0.08, "y": 0.08, "w": 0.6, "h": 0.06}}])
    assert all(sum(c) > 700 for c in _region_colors(out, 0, clip)), "should be blank"
    # …and the glyphs are still in the file. This is not redaction.
    assert "Sample document" in _text(out, 0)


def test_whiteout_accepts_a_colour(fixture_bytes):
    out = C.whiteout(fixture_bytes("text.pdf"), color="#ff0000",
                     rects=[{"page": 0, "rect": {"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.05}}])
    rect = _page_rect(out)
    colors = _region_colors(out, 0, fitz.Rect(0.15 * rect.width, 0.11 * rect.height,
                                              0.3 * rect.width, 0.13 * rect.height))
    assert any(c[0] > 200 and c[1] < 60 for c in colors), colors


# --------------------------------------------------------------------------- #
# find & replace
# --------------------------------------------------------------------------- #
def test_find_replace_dry_run_changes_nothing_and_lists_matches(fixture_bytes):
    data, report = C.find_replace(fixture_bytes("text.pdf"), find="page", dry_run=True)
    assert data is None, "a dry run must not produce bytes"
    assert report["dry_run"] is True
    assert report["count"] >= 3
    assert report["replaced"] == 0
    first = report["matches"][0]
    assert first["id"].startswith("p0:")
    assert first["context"]
    assert 0 <= first["rect"]["x"] <= 1


def test_find_replace_dry_run_count_equals_executed_count(fixture_bytes):
    data = fixture_bytes("text.pdf")
    _, preview = C.find_replace(data, find="quick", dry_run=True)
    out, applied = C.find_replace(data, find="quick", replace="rapid")
    assert applied["replaced"] == preview["count"]
    assert "rapid" in _text(out)
    assert "quick" not in _text(out)


def test_find_replace_honours_only(fixture_bytes):
    """The two-step flow: review with checkboxes, then execute the kept ids."""
    data = fixture_bytes("text.pdf")
    _, preview = C.find_replace(data, find="page", dry_run=True)
    assert preview["count"] >= 3
    keep = [preview["matches"][0]["id"]]

    out, applied = C.find_replace(data, find="page", replace="SHEET", only=keep)
    assert applied["replaced"] == 1
    text = _text(out)
    assert "SHEET" in text
    assert "page" in text, "the matches the user unchecked must survive"


def test_find_replace_is_case_insensitive_by_default(fixture_bytes):
    data = fixture_bytes("text.pdf")
    _, insensitive = C.find_replace(data, find="SAMPLE", dry_run=True)
    _, sensitive = C.find_replace(data, find="SAMPLE", match_case=True, dry_run=True)
    assert insensitive["count"] > 0
    assert sensitive["count"] == 0


def test_find_replace_can_be_scoped_to_pages(fixture_bytes):
    _, report = C.find_replace(fixture_bytes("text.pdf"), find="page", pages=[1],
                               dry_run=True)
    assert report["count"] > 0
    assert {m["page"] for m in report["matches"]} == {1}


def test_find_replace_across_fifty_pages_is_quick(fixture_bytes):
    """Acceptance: <60 s across a 50-page document. Measured, not assumed."""
    import time

    doc = fitz.open(stream=fixture_bytes("large-generated.pdf"), filetype="pdf")
    try:
        doc.select(list(range(50)))
        fifty = doc.tobytes()
    finally:
        doc.close()

    started = time.monotonic()
    out, report = C.find_replace(fifty, find="Large", replace="Big")
    elapsed = time.monotonic() - started
    assert report["replaced"] == 50
    # Redact-and-reinsert draws the replacement as its own content box, so it is
    # positioned where the match was but is not necessarily adjacent in
    # extraction order. Assert the substitution, not the reading order.
    page0 = _text(out, 0)
    assert "Big" in page0
    assert "Large" not in page0
    assert elapsed < 60, f"50-page find & replace took {elapsed:.1f}s"


def test_find_replace_rejects_an_empty_needle(fixture_bytes):
    with pytest.raises(InvalidParams):
        C.find_replace(fixture_bytes("text.pdf"), find="")


# --------------------------------------------------------------------------- #
# images
# --------------------------------------------------------------------------- #
def _png(rgb=(255, 0, 0), size=(60, 40)) -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, *size))
    pix.set_rect(pix.irect, rgb)
    return pix.tobytes("png")


def test_add_image_lands_where_it_was_asked_for(fixture_bytes):
    out = C.add_image(fixture_bytes("text.pdf"), page=0,
                      rect={"x": 0.1, "y": 0.6, "w": 0.3, "h": 0.2},
                      image=_png(), keep_aspect=False)
    rect = _page_rect(out)
    colors = _region_colors(out, 0, fitz.Rect(0.15 * rect.width, 0.65 * rect.height,
                                              0.35 * rect.width, 0.75 * rect.height))
    assert any(c[0] > 200 and c[1] < 60 for c in colors), colors


def test_delete_image_removes_only_the_image(fixture_bytes):
    """Text sharing the page must survive — the redaction machinery's default
    would take the glyphs inside the picture's box with it."""
    base = C.add_text(fixture_bytes("text.pdf"), boxes=[{
        "page": 0, "rect": {"x": 0.1, "y": 0.62, "w": 0.5, "h": 0.05},
        "text": "caption under the picture",
    }])
    with_image = C.add_image(base, page=0,
                             rect={"x": 0.1, "y": 0.7, "w": 0.3, "h": 0.2},
                             image=_png())
    xref = C.page_images(with_image, 0)["images"][0]["xref"]

    out = C.delete_image(with_image, page=0, xref=xref)
    assert C.page_images(out, 0)["images"] == []
    assert "caption under the picture" in _text(out, 0)
    assert "Sample document" in _text(out, 0)


def test_replace_image_swaps_the_pixels(fixture_bytes):
    with_image = C.add_image(fixture_bytes("text.pdf"), page=0,
                             rect={"x": 0.1, "y": 0.6, "w": 0.3, "h": 0.2},
                             image=_png((255, 0, 0)), keep_aspect=False)
    xref = C.page_images(with_image, 0)["images"][0]["xref"]
    out = C.replace_image(with_image, page=0, xref=xref, image=_png((0, 0, 255)))

    rect = _page_rect(out)
    colors = _region_colors(out, 0, fitz.Rect(0.15 * rect.width, 0.65 * rect.height,
                                              0.35 * rect.width, 0.75 * rect.height))
    assert any(c[2] > 200 and c[0] < 60 for c in colors), colors


def test_image_ops_reject_an_xref_that_is_not_on_the_page(fixture_bytes):
    with pytest.raises(InvalidParams):
        C.delete_image(fixture_bytes("text.pdf"), page=0, xref=99999)


# --------------------------------------------------------------------------- #
# links
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("uri", [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html;base64,PHNjcmlwdD4=",
    "",
])
def test_links_refuse_dangerous_schemes(fixture_bytes, uri):
    """A PDF link is a click target in someone else's reader."""
    with pytest.raises(InvalidParams):
        C.add_link(fixture_bytes("text.pdf"), page=0,
                   rect={"x": 0.1, "y": 0.5, "w": 0.2, "h": 0.03},
                   kind="uri", uri=uri)


def test_internal_page_links_round_trip(fixture_bytes):
    out = C.add_link(fixture_bytes("text.pdf"), page=0,
                     rect={"x": 0.1, "y": 0.5, "w": 0.2, "h": 0.03},
                     kind="page", page_target=2)
    links = C.page_links(out, 0)["links"]
    assert links[0]["kind"] == "page"
    assert links[0]["page"] == 2


def test_internal_link_target_must_exist(fixture_bytes):
    with pytest.raises(PageOutOfRange):
        C.add_link(fixture_bytes("text.pdf"), page=0,
                   rect={"x": 0.1, "y": 0.5, "w": 0.2, "h": 0.03},
                   kind="page", page_target=99)


def test_delete_link_removes_it(fixture_bytes):
    out = C.add_link(fixture_bytes("text.pdf"), page=0,
                     rect={"x": 0.1, "y": 0.5, "w": 0.2, "h": 0.03},
                     kind="uri", uri="https://example.com")
    assert len(C.page_links(out, 0)["links"]) == 1
    gone = C.delete_link(out, page=0, index=0)
    assert C.page_links(gone, 0)["links"] == []


def test_edit_link_changes_the_target(fixture_bytes):
    out = C.add_link(fixture_bytes("text.pdf"), page=0,
                     rect={"x": 0.1, "y": 0.5, "w": 0.2, "h": 0.03},
                     kind="uri", uri="https://example.com/old")
    edited = C.edit_link(out, page=0, index=0,
                         rect={"x": 0.2, "y": 0.5, "w": 0.2, "h": 0.03},
                         kind="uri", uri="https://example.com/new")
    links = C.page_links(edited, 0)["links"]
    assert len(links) == 1
    assert links[0]["uri"].endswith("/new")


# --------------------------------------------------------------------------- #
# stamping suite
# --------------------------------------------------------------------------- #
def test_page_numbers_number_every_page(fixture_bytes):
    out = C.page_numbers(fixture_bytes("text.pdf"), format="Page {page} of {total}")
    assert "Page 1 of 3" in _text(out, 0)
    assert "Page 2 of 3" in _text(out, 1)
    assert "Page 3 of 3" in _text(out, 2)


def test_page_numbers_skip_first_and_restart(fixture_bytes):
    """Acceptance: stamps honour range + skip-first."""
    out = C.page_numbers(fixture_bytes("text.pdf"), format="[{page}]",
                         start_at=1, range={"skip_first": True})
    assert "[1]" not in _text(out, 0), "the cover must stay unstamped"
    assert "[1]" in _text(out, 1)
    assert "[2]" in _text(out, 2)


def test_page_numbers_honour_an_explicit_range(fixture_bytes):
    out = C.page_numbers(fixture_bytes("text.pdf"), format="<{page}>",
                         range={"pages": [2]})
    assert "<" not in _text(out, 0)
    assert "<1>" in _text(out, 2)


def test_header_footer_fills_the_slots_and_computes_tokens(fixture_bytes):
    out = C.header_footer(fixture_bytes("text.pdf"), segments={
        "top-left": "ACME Corp",
        "top-right": "{date}",
        "bottom-center": "{page} / {total}",
    })
    page0 = _text(out, 0)
    assert "ACME Corp" in page0
    assert "1 / 3" in page0
    assert C._today() in page0


def test_header_footer_needs_a_segment(fixture_bytes):
    with pytest.raises(InvalidParams):
        C.header_footer(fixture_bytes("text.pdf"), segments={})


def test_bates_is_continuous_and_reports_its_range(fixture_bytes):
    out, report = C.bates(fixture_bytes("text.pdf"), prefix="ACME-", start=41, digits=6)
    assert report["first"] == "ACME-000041"
    assert report["last"] == "ACME-000043"
    assert report["pages"] == 3
    assert "ACME-000041" in _text(out, 0)
    assert "ACME-000042" in _text(out, 1)
    assert "ACME-000043" in _text(out, 2)


def test_bates_over_a_range_stays_continuous(fixture_bytes):
    out, report = C.bates(fixture_bytes("text.pdf"), start=1, digits=4,
                          range={"skip_first": True})
    assert report["first"] == "0001"
    assert report["last"] == "0002"
    assert "0001" in _text(out, 1)


@pytest.mark.parametrize("bad", [{"digits": 0}, {"digits": 99}, {"start": -1},
                                 {"position": "middle"}])
def test_bates_guardrails(fixture_bytes, bad):
    with pytest.raises(InvalidParams):
        C.bates(fixture_bytes("text.pdf"), **bad)


def test_watermark_under_content_leaves_text_extractable(fixture_bytes):
    """Drawn beneath the content, so it obscures nothing and the document stays
    searchable — that is the point of the `under` flag."""
    out = C.watermark(fixture_bytes("text.pdf"), text="DRAFT", under=True, opacity=0.3)
    assert "Sample document" in _text(out, 0)
    assert "DRAFT" in _text(out, 0)


def test_watermark_tiled_repeats(fixture_bytes):
    plain = C.watermark(fixture_bytes("text.pdf"), text="COPY", tiled=False)
    tiled = C.watermark(fixture_bytes("text.pdf"), text="COPY", tiled=True)
    assert _text(tiled, 0).count("COPY") > _text(plain, 0).count("COPY")


def test_watermark_image_renders(fixture_bytes):
    out = C.watermark(fixture_bytes("text.pdf"), image=_png((255, 0, 0)), opacity=1.0)
    rect = _page_rect(out)
    colors = _region_colors(out, 0, fitz.Rect(0.4 * rect.width, 0.45 * rect.height,
                                              0.6 * rect.width, 0.55 * rect.height))
    assert any(c[0] > 150 and c[1] < 120 for c in colors), colors


def test_watermark_needs_something_to_draw(fixture_bytes):
    with pytest.raises(InvalidParams):
        C.watermark(fixture_bytes("text.pdf"))


def test_watermark_rejects_a_silly_opacity(fixture_bytes):
    with pytest.raises(InvalidParams):
        C.watermark(fixture_bytes("text.pdf"), text="X", opacity=0)


def test_overlay_pdf_stamps_a_letterhead(fixture_bytes):
    letterhead = C.add_text(fixture_bytes("text.pdf"), boxes=[{
        "page": 0, "rect": {"x": 0.1, "y": 0.02, "w": 0.7, "h": 0.05},
        "text": "LETTERHEAD BANNER",
    }])
    out = C.overlay_pdf(fixture_bytes("unicode.pdf"), letterhead, mode="foreground")
    assert "LETTERHEAD BANNER" in _text(out, 0)
    assert "Café" in _text(out, 0), "the underlying page must survive"


def test_overlay_pdf_rejects_a_bad_mode(fixture_bytes):
    with pytest.raises(InvalidParams):
        C.overlay_pdf(fixture_bytes("text.pdf"), fixture_bytes("unicode.pdf"),
                      mode="sideways")


# --------------------------------------------------------------------------- #
# metadata & bookmarks
# --------------------------------------------------------------------------- #
def test_metadata_round_trip(fixture_bytes):
    out = C.set_metadata(fixture_bytes("text.pdf"), title="Quarterly report",
                         author="A. Person", keywords="q3,report")
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert doc.metadata["title"] == "Quarterly report"
        assert doc.metadata["author"] == "A. Person"
        assert doc.metadata["keywords"] == "q3,report"
    finally:
        doc.close()


def test_metadata_clear_empties_it(fixture_bytes):
    filled = C.set_metadata(fixture_bytes("text.pdf"), title="Something")
    cleared = C.set_metadata(filled, clear=True)
    doc = fitz.open(stream=cleared, filetype="pdf")
    try:
        assert not doc.metadata.get("title")
    finally:
        doc.close()


def test_bookmarks_round_trip(fixture_bytes):
    out = C.set_bookmarks(fixture_bytes("text.pdf"), toc=[
        [1, "Introduction", 1],
        [2, "Background", 2],
        [1, "Conclusion", 3],
    ])
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        toc = doc.get_toc(simple=True)
    finally:
        doc.close()
    assert [t[1] for t in toc] == ["Introduction", "Background", "Conclusion"]
    assert [t[0] for t in toc] == [1, 2, 1]


def test_bookmarks_reject_a_level_jump_naming_the_entry(fixture_bytes):
    with pytest.raises(InvalidParams) as exc:
        C.set_bookmarks(fixture_bytes("text.pdf"), toc=[[1, "One", 1], [3, "Too deep", 2]])
    assert "Too deep" in str(exc.value)


def test_bookmarks_reject_an_impossible_page(fixture_bytes):
    with pytest.raises(PageOutOfRange):
        C.set_bookmarks(fixture_bytes("text.pdf"), toc=[[1, "Nowhere", 99]])


def test_bookmarks_can_be_emptied(fixture_bytes):
    withtoc = C.set_bookmarks(fixture_bytes("text.pdf"), toc=[[1, "X", 1]])
    cleared = C.set_bookmarks(withtoc, toc=[])
    doc = fitz.open(stream=cleared, filetype="pdf")
    try:
        assert doc.get_toc(simple=True) == []
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Shared guardrails
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("call", [
    lambda d: C.text_blocks(d, 0),
    lambda d: C.edit_text(d, edits=[{"page": 0,
                                     "block_bbox": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1},
                                     "new_text": "x"}]),
    lambda d: C.watermark(d, text="X"),
    lambda d: C.set_metadata(d, title="X"),
])
def test_encrypted_documents_are_refused(fixture_bytes, call):
    with pytest.raises(DocumentEncryptedError):
        call(fixture_bytes("encrypted.pdf"))


def test_stamps_land_correctly_on_a_rotated_page(fixture_bytes):
    """Same trap as phase 3: what PyMuPDF *writes* is unrotated space (§8)."""
    out = C.page_numbers(fixture_bytes("rotated-90.pdf"), format="P{page}")
    assert "P1" in _text(out, 0)

    doc = fitz.open(stream=out, filetype="pdf")
    try:
        page = doc[0]
        found = page.search_for("P1")
        assert found, "the stamp must be findable in display space"
        # bottom-center by default: low on the page, horizontally central.
        hit = found[0]
        assert hit.y0 > page.rect.height * 0.75, f"stamped at y={hit.y0}"
        assert page.rect.width * 0.3 < hit.x0 < page.rect.width * 0.7
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Gaps closed after the phase-4 self-review
# --------------------------------------------------------------------------- #
def _page_pixels(data: bytes, page: int = 0):
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return doc[page].get_pixmap(dpi=72)
    finally:
        doc.close()


def _diff_ratio(a, b, clip: fitz.IRect) -> float:
    """Fraction of sampled pixels inside `clip` that differ between two renders."""
    differing = total = 0
    for y in range(clip.y0, min(clip.y1, a.height, b.height), 2):
        for x in range(clip.x0, min(clip.x1, a.width, b.width), 2):
            total += 1
            pa, pb = a.pixel(x, y), b.pixel(x, y)
            if max(abs(pa[i] - pb[i]) for i in range(3)) > 24:
                differing += 1
    return differing / max(1, total)


def test_a_same_text_edit_leaves_the_rest_of_the_page_pixel_identical(fixture_bytes):
    """The visual half of acceptance criterion 2, measured where it is
    meaningful — and honest about where it is not.

    **Outside the edited block: exactly zero pixels change.** That is the strong
    guarantee, it is what "neighbours untouched" means, and it is what would
    break first if the redaction were too greedy or the reinsertion landed in
    the wrong place.

    **Inside the block it cannot be zero, and it cannot be 15% either.** The
    criterion's 15% budget assumes a like-for-like re-render; ours is not one.
    The original glyphs were placed by `insert_text` at an exact baseline, the
    replacement is laid out by `insert_htmlbox` inside a box, and the two
    disagree on origin and leading by a few points — which moves every glyph and
    therefore changes a quarter of the pixels in a text-dense box even when the
    font is base-14 Helvetica and nothing is substituted at all. Measured at
    ~25% on this fixture; tightening the CSS (margin/line-height) was tried and
    made it *worse*, so it was reverted rather than kept for appearances.

    The bound below is set to catch gross breakage — text landing in the wrong
    place, at the wrong size, or not at all — rather than to assert a number the
    approach cannot deliver. Recorded in the Decisions log rather than quietly
    reinterpreted.
    """
    data = fixture_bytes("text.pdf")
    block = _blocks(data)[0]
    out = C.edit_text(data, edits=[{
        "page": 0, "block_bbox": block["bbox"], "new_text": block["text"],
        "style": {"size": 22},
    }])

    before, after = _page_pixels(data), _page_pixels(out)
    w, h = before.width, before.height
    bb = block["bbox"]
    inside = fitz.IRect(int(bb["x"] * w) - 2, int(bb["y"] * h) - 2,
                        int((bb["x"] + bb["w"]) * w) + 2,
                        int((bb["y"] + bb["h"]) * h) + 2)

    # Everything below the edited block must be untouched.
    below = fitz.IRect(0, inside.y1 + 4, w, h)
    assert _diff_ratio(before, after, below) == 0.0, "content outside the block moved"

    in_block = _diff_ratio(before, after, inside)
    assert in_block < 0.45, (
        f"edited region differs by {in_block:.1%} — expected ~25% for a "
        "same-text roundtrip; well above that means the text moved, resized or "
        "vanished"
    )


def test_editing_a_block_does_not_disturb_an_image_beside_it(fixture_bytes):
    """phase-04's Tests line: "neighbors untouched (text **+ images**)".

    This is what `PDF_REDACT_IMAGE_NONE` is for — the redaction that clears the
    old glyphs must not take a figure sharing the page with them.
    """
    with_image = C.add_image(fixture_bytes("text.pdf"), page=0,
                             rect={"x": 0.55, "y": 0.08, "w": 0.3, "h": 0.12},
                             image=_png((255, 0, 0)), keep_aspect=False)
    block = _blocks(with_image)[0]

    out = C.edit_text(with_image, edits=[{
        "page": 0, "block_bbox": block["bbox"], "new_text": "Replaced heading",
    }])

    assert len(C.page_images(out, 0)["images"]) == 1, "the image was removed"
    rect = _page_rect(out)
    colors = _region_colors(out, 0, fitz.Rect(0.6 * rect.width, 0.10 * rect.height,
                                              0.8 * rect.width, 0.18 * rect.height))
    assert any(c[0] > 200 and c[1] < 60 for c in colors), "the image pixels are gone"


def test_watermark_honours_a_range_and_skip_first(fixture_bytes):
    out = C.watermark(fixture_bytes("text.pdf"), text="DRAFT", under=True,
                      opacity=1.0, range={"skip_first": True})
    assert "DRAFT" not in _text(out, 0), "the cover must stay unmarked"
    assert "DRAFT" in _text(out, 1)
    assert "DRAFT" in _text(out, 2)

    only_last = C.watermark(fixture_bytes("text.pdf"), text="COPY", under=True,
                            opacity=1.0, range={"pages": [2]})
    assert "COPY" not in _text(only_last, 0)
    assert "COPY" in _text(only_last, 2)


def test_overlay_pdf_honours_a_range(fixture_bytes):
    letterhead = C.add_text(fixture_bytes("text.pdf"), boxes=[{
        "page": 0, "rect": {"x": 0.1, "y": 0.02, "w": 0.7, "h": 0.05},
        "text": "LETTERHEAD BANNER",
    }])
    out = C.overlay_pdf(fixture_bytes("text.pdf"), letterhead,
                        range={"pages": [1]})
    assert "LETTERHEAD BANNER" not in _text(out, 0)
    assert "LETTERHEAD BANNER" in _text(out, 1)
    assert "LETTERHEAD BANNER" not in _text(out, 2)


def test_a_text_watermark_is_drawn_at_the_angle_asked_for(fixture_bytes):
    """−45° must be a diagonal, not a quarter turn.

    `insert_htmlbox` only rotates in 90° steps, so the first implementation
    silently rendered the spec'd default as a vertical 270°.
    """
    def ink_spread(rotation: int) -> tuple[float, float]:
        # A distinct colour, so the measurement cannot pick up the page's own
        # (antialiased, therefore grey) body text.
        out = C.watermark(fixture_bytes("text.pdf"), text="CONFIDENTIAL",
                          rotation=rotation, opacity=1.0, size=44, under=False,
                          color="#ff0000")
        pm = _page_pixels(out)
        pts = [(x / pm.width, y / pm.height)
               for y in range(0, pm.height, 3) for x in range(0, pm.width, 3)
               if pm.pixel(x, y)[0] > 140 and pm.pixel(x, y)[1] < 110
               and pm.pixel(x, y)[2] < 110]
        assert pts, f"no watermark ink at rotation={rotation}"
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return (max(xs) - min(xs), max(ys) - min(ys))

    flat_x, flat_y = ink_spread(0)
    diag_x, diag_y = ink_spread(-45)

    # Horizontal text is wide and short; a diagonal covers far more height.
    assert flat_y < 0.2, f"rotation=0 should be a flat band, got height {flat_y:.2f}"
    assert diag_y > flat_y * 1.8, (
        f"rotation=-45 should be diagonal: height {diag_y:.2f} vs flat {flat_y:.2f}"
    )
    assert diag_x > 0.2, "a diagonal still spans horizontally"


def test_watermark_text_stays_extractable_at_any_angle(fixture_bytes):
    out = C.watermark(fixture_bytes("text.pdf"), text="CONFIDENTIAL",
                      rotation=-45, under=True, opacity=0.3)
    assert "CONFIDENTIAL" in _text(out, 0)
    assert "Sample document" in _text(out, 0)


# --------------------------------------------------------------------------- #
# Correctness bugs found by the phase-4 self-review
# --------------------------------------------------------------------------- #
def _one_line(text: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), text, fontsize=14)
    try:
        return doc.tobytes()
    finally:
        doc.close()


def test_adjacent_occurrences_are_separate_matches(fixture_bytes):
    """`search_for` returns ONE rect for directly-abutting hits.

    Redacting that rect and writing a single replacement silently **deleted**
    the second occurrence, and the dry run under-reported what the user was
    about to change. "banana" contains "na" twice, not once.
    """
    data = _one_line("banana bread catcat")

    _, preview = C.find_replace(data, find="na", dry_run=True)
    assert preview["count"] == 2, "both occurrences must be offered for review"

    out, report = C.find_replace(data, find="na", replace="NA")
    assert report["replaced"] == 2
    text = _text(out)
    assert text.count("NA") == 2, "the second occurrence was dropped"

    out2, report2 = C.find_replace(data, find="cat", replace="XY")
    assert report2["replaced"] == 2
    assert _text(out2).count("XY") == 2


def test_a_wider_same_length_replacement_still_fits(fixture_bytes):
    """"cat" → "CAT" is the same length and measurably wider.

    Sizing the replacement box off character count made that overflow, and an
    overflow fails the *whole* job — so a single capitalisation aborted a
    document-wide replace.
    """
    data = _one_line("the cat sat on the mat")
    for replacement in ("CAT", "DOG", "iPhone"):
        out, report = C.find_replace(data, find="cat", replace=replacement)
        assert report["replaced"] == 1
        assert replacement in _text(out)


def test_a_long_replacement_near_the_margin_stays_on_the_page(fixture_bytes):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((500, 100), "cat", fontsize=12)
    data = doc.tobytes()
    doc.close()

    out, report = C.find_replace(data, find="cat", replace="caterpillar habitat")
    assert report["replaced"] == 1
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        page = doc[0]
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") == 0:
                assert block["bbox"][2] <= page.mediabox.x1 + 1, (
                    f"text runs off the page: {block['bbox']}"
                )
    finally:
        doc.close()


def test_find_replace_works_on_a_rotated_page(fixture_bytes):
    """`search_for` answers in *unrotated* space, exactly like `get_text` — the
    opposite of what this module first assumed. With the transform wrong, the
    redaction missed, `match_case` matched nothing, and the context was blank.
    """
    data = fixture_bytes("rotated-90.pdf")

    _, preview = C.find_replace(data, find="Rotated", dry_run=True)
    assert preview["count"] >= 1
    assert preview["matches"][0]["context"], "the review list showed blank rows"

    _, sensitive = C.find_replace(data, find="Rotated", match_case=True, dry_run=True)
    assert sensitive["count"] >= 1, "case-sensitive search found nothing at all"

    out, report = C.find_replace(data, find="Rotated", replace="Turned")
    assert report["replaced"] >= 1
    text = _text(out)
    assert "Turned" in text
    assert "Rotated fixture" not in text, "the redaction missed the original"


def test_editing_a_block_on_a_rotated_page_works(fixture_bytes):
    """Every edit on a landscape-rotated page used to fail with `text_overflow`.

    The block's *display* box is tall and narrow (the text reads vertically to
    the viewer), so horizontal layout could never fit it. The replacement is
    written in the page's unrotated space, where the original glyphs were.
    """
    data = fixture_bytes("rotated-90.pdf")
    block = _blocks(data)[0]
    out = C.edit_text(data, edits=[{
        "page": 0, "block_bbox": block["bbox"], "new_text": "Edited on a rotated page",
    }])
    assert "Edited on a rotated page" in _text(out, 0)
    assert "Rotated fixture page 1" not in _text(out, 0)

    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert doc[0].rotation == 90, "the page rotation must be preserved"
    finally:
        doc.close()


def test_page_and_total_are_counted_in_the_same_space(fixture_bytes):
    """"1 of 10" on the second page of a ten-page document whose cover was
    skipped is two numbering schemes in one string."""
    out = C.page_numbers(fixture_bytes("text.pdf"), format="{page} of {total}",
                         range={"skip_first": True})
    assert "1 of 2" in _text(out, 1)
    assert "2 of 2" in _text(out, 2)


def test_skip_first_means_something_with_an_explicit_range(fixture_bytes):
    """It drops the first page *of the selection*. Dropping index 0
    unconditionally made the flag a silent no-op alongside an explicit range."""
    out = C.page_numbers(fixture_bytes("text.pdf"), format="<{page}>",
                         range={"pages": [1, 2], "skip_first": True})
    assert "<" not in _text(out, 0)
    assert "<" not in _text(out, 1), "the first page of the selection was stamped"
    assert "<1>" in _text(out, 2)


def test_read_models_survive_content_outside_the_page(fixture_bytes):
    """Print PDFs routinely place content off-page — a CropBox inset for trim
    marks, or a full-bleed image. Reporting that as a hard error made every read
    model answer 500 for an ordinary print-ready file."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((-40, -10), "bleeding off the corner", fontsize=14)
    page.insert_image(fitz.Rect(-30, -30, 300, 200), stream=_png())
    page.set_cropbox(fitz.Rect(18, 18, 577, 824))
    data = doc.tobytes()
    doc.close()

    blocks = C.text_blocks(data, 0)
    images = C.page_images(data, 0)
    assert C.page_links(data, 0)["links"] == []
    for rect in [b["bbox"] for b in blocks["blocks"]] + [i["bbox"] for i in images["images"]]:
        assert 0 <= rect["x"] <= 1 and 0 <= rect["y"] <= 1
        assert rect["x"] + rect["w"] <= 1.001
        assert rect["y"] + rect["h"] <= 1.001


def test_page_images_does_not_multiply_duplicate_placements(fixture_bytes):
    """Matching placements by decoded-pixel MD5 returned the union of every
    identical image's boxes, so N duplicate images produced N² entries — which
    is what merging N copies of a document produces naturally."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    png = _png()
    for i in range(8):
        page.insert_image(fitz.Rect(20, 20 + i * 60, 120, 70 + i * 60), stream=png)
    data = doc.tobytes()
    doc.close()

    images = C.page_images(data, 0)["images"]
    assert len(images) == 8, f"expected 8 placements, got {len(images)}"
