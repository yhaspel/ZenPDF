"""Golden tests for the annotations engine (phase-03; §8, §10, §18).

Assertions are structural (annot objects, extracted fields, rendered pixels),
never byte-equality — PDF output is nondeterministic.
"""
import io

import fitz
import pytest

from apps.pdf_engine.engine import annotations as A
from apps.pdf_engine.engine import text as T
from apps.pdf_engine.exceptions import (
    DocumentEncryptedError,
    InvalidParams,
    PageOutOfRange,
)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _annots(data: bytes, page: int = 0) -> list:
    """Note the local `pg`: PyMuPDF holds `annot.parent` weakly, so reading annot
    attributes off a temporary `doc[page]` reads freed memory (segfault)."""
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        pg = doc[page]
        return [(a.type[1], (a.info or {}).get("id")) for a in pg.annots()]
    finally:
        doc.close()


def _pypdf_annot_count(data: bytes, page: int = 0) -> int:
    """Real annotations in `/Annots`, read by a *different* library than the one
    that wrote them.

    `/Popup` entries are excluded: a `/Text` (note) annotation with contents
    legitimately carries an associated popup object, which is PDF structure
    rather than a second annotation the user made.
    """
    import pypdf

    reader = pypdf.PdfReader(io.BytesIO(data))
    entries = reader.pages[page].get("/Annots", []) or []
    return sum(
        1 for ref in entries
        if (ref.get_object() or {}).get("/Subtype") != "/Popup"
    )


def _add(annotation: dict) -> list[dict]:
    return [{"action": "add", "annotation": annotation}]


def _region_colors(data: bytes, page: int, clip: fitz.Rect) -> set:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        pm = doc[page].get_pixmap(clip=clip)
        return {pm.pixel(x, y)
                for y in range(0, pm.height, 4) for x in range(0, pm.width, 4)}
    finally:
        doc.close()


HIGHLIGHT = {
    "id": "aaaaaaaa-1111", "page": 0, "type": "highlight",
    "quads": [{"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.02}],
    "color": "#ffff00", "opacity": 0.5, "contents": "look here",
}


# --------------------------------------------------------------------------- #
# Every type round-trips: create → extract → fields match
# --------------------------------------------------------------------------- #
ROUND_TRIP_CASES = [
    ("highlight", HIGHLIGHT),
    ("underline", {**HIGHLIGHT, "id": "u1", "type": "underline"}),
    ("strikeout", {**HIGHLIGHT, "id": "s1", "type": "strikeout"}),
    ("squiggly", {**HIGHLIGHT, "id": "q1", "type": "squiggly"}),
    ("note", {"id": "n1", "page": 0, "type": "note",
              "rect": {"x": 0.5, "y": 0.5, "w": 0.03, "h": 0.03},
              "contents": "a comment", "icon": "Comment"}),
    ("free_text", {"id": "f1", "page": 0, "type": "free_text",
                   "rect": {"x": 0.1, "y": 0.6, "w": 0.4, "h": 0.08},
                   "contents": "typed box", "font_size": 14, "color": "#0000ff"}),
    ("square", {"id": "r1", "page": 0, "type": "square",
                "rect": {"x": 0.1, "y": 0.3, "w": 0.2, "h": 0.1},
                "color": "#ff0000", "width": 2}),
    ("circle", {"id": "c1", "page": 0, "type": "circle",
                "rect": {"x": 0.4, "y": 0.3, "w": 0.2, "h": 0.1},
                "color": "#00ff00", "width": 2}),
    ("line", {"id": "l1", "page": 0, "type": "line",
              "vertices": [[0.1, 0.8], [0.5, 0.85]], "color": "#000000", "width": 2}),
    ("arrow", {"id": "a1", "page": 0, "type": "arrow",
               "vertices": [[0.1, 0.9], [0.5, 0.92]], "color": "#000000", "width": 2}),
    ("polygon", {"id": "p1", "page": 0, "type": "polygon",
                 "vertices": [[0.6, 0.6], [0.8, 0.65], [0.7, 0.75]], "color": "#ff00ff"}),
    ("polyline", {"id": "pl1", "page": 0, "type": "polyline",
                  "vertices": [[0.6, 0.8], [0.8, 0.85], [0.7, 0.9]], "color": "#00ffff"}),
    ("ink", {"id": "i1", "page": 0, "type": "ink",
             "ink": [[[0.2, 0.5], [0.25, 0.52], [0.3, 0.5]], [[0.35, 0.5], [0.4, 0.55]]],
             "color": "#006600", "width": 3}),
    ("stamp", {"id": "st1", "page": 0, "type": "stamp",
               "rect": {"x": 0.6, "y": 0.1, "w": 0.3, "h": 0.06},
               "stamp_name": "Approved"}),
]


@pytest.mark.parametrize("kind,spec", ROUND_TRIP_CASES, ids=[c[0] for c in ROUND_TRIP_CASES])
def test_every_annotation_type_round_trips(fixture_bytes, kind, spec):
    out, report = A.apply_annotation_ops(
        fixture_bytes("text.pdf"), ops=_add(spec), author="Alice"
    )
    assert report["added"] == 1

    # The object really is in the file — asserted through a *different* library
    # so we are not just believing PyMuPDF about its own output.
    assert _pypdf_annot_count(out) == 1

    items = A.extract_annotations(out)
    assert len(items) == 1
    got = items[0]
    assert got["id"] == spec["id"]
    assert got["type"] == kind
    assert got["page"] == 0
    assert got["author"] == "Alice"
    if "contents" in spec:
        assert got["contents"] == spec["contents"]
    if "color" in spec:
        assert got["color"] == spec["color"]
    if "quads" in spec:
        assert len(got["quads"]) == len(spec["quads"])
        assert got["quads"][0]["x"] == pytest.approx(spec["quads"][0]["x"], abs=0.01)
    if "ink" in spec:
        assert len(got["ink"]) == len(spec["ink"])
        assert got["ink"][0][0][0] == pytest.approx(spec["ink"][0][0][0], abs=0.005)
    if "vertices" in spec and kind in {"polygon", "polyline"}:
        assert len(got["vertices"]) == len(spec["vertices"])
    if kind == "stamp":
        assert got["stamp_name"] == "Approved"
    if kind == "note":
        assert got["icon"] == "Comment"
    if kind == "free_text":
        assert got["font_size"] == pytest.approx(14, abs=0.01)


def test_author_defaults_to_guest(fixture_bytes):
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(HIGHLIGHT))
    assert A.extract_annotations(out)[0]["author"] == "Guest"


def test_author_never_leaks_a_session_id(fixture_bytes):
    """phase-03 §3: authorship is a display name or "Guest" — the file is going
    to be shared, so a session id or IP must never end up inside it."""
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(HIGHLIGHT),
                                    author="Guest")
    assert b"guest_session" not in out
    assert A.extract_annotations(out)[0]["author"] == "Guest"


# --------------------------------------------------------------------------- #
# Update / delete address stable NMs
# --------------------------------------------------------------------------- #
def test_update_moves_the_rect_and_keeps_the_id(fixture_bytes):
    spec = {"id": "move-me", "page": 0, "type": "square",
            "rect": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1}, "color": "#ff0000"}
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(spec))
    before = A.extract_annotations(out)[0]

    moved = {**spec, "rect": {"x": 0.5, "y": 0.6, "w": 0.2, "h": 0.1}}
    out2, report = A.apply_annotation_ops(
        out, ops=[{"action": "update", "annotation": moved}]
    )
    assert report["updated"] == 1
    after = A.extract_annotations(out2)
    assert len(after) == 1
    assert after[0]["id"] == "move-me"
    assert after[0]["rect"]["x"] > before["rect"]["x"] + 0.3


def test_update_preserves_the_original_creation_date(fixture_bytes):
    spec = {"id": "keep-created", "page": 0, "type": "square",
            "rect": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1}}
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(spec))
    created = A.extract_annotations(out)[0]["created"]
    assert created
    out2, _ = A.apply_annotation_ops(
        out, ops=[{"action": "update", "annotation": {**spec, "contents": "edited"}}]
    )
    assert A.extract_annotations(out2)[0]["created"] == created


def test_delete_removes_only_the_named_annotation(fixture_bytes):
    ops = [
        {"action": "add", "annotation": {**HIGHLIGHT, "id": "one"}},
        {"action": "add", "annotation": {**HIGHLIGHT, "id": "two",
                                         "quads": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.02}]}},
    ]
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=ops)
    assert len(A.extract_annotations(out)) == 2

    out2, report = A.apply_annotation_ops(
        out, ops=[{"action": "delete", "annotation": {"id": "one"}}]
    )
    assert report["deleted"] == 1
    remaining = A.extract_annotations(out2)
    assert [a["id"] for a in remaining] == ["two"]


def test_deleting_a_missing_annotation_is_a_no_op(fixture_bytes):
    """Draft replay after a version conflict must not fail the whole batch."""
    out, report = A.apply_annotation_ops(
        fixture_bytes("text.pdf"),
        ops=[{"action": "delete", "annotation": {"id": "never-existed"}},
             {"action": "add", "annotation": HIGHLIGHT}],
    )
    assert report["missing"] == 1
    assert report["added"] == 1
    assert len(A.extract_annotations(out)) == 1


def test_replayed_add_updates_instead_of_duplicating(fixture_bytes):
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(HIGHLIGHT))
    out2, report = A.apply_annotation_ops(out, ops=_add(HIGHLIGHT))
    assert report["updated"] == 1
    assert len(A.extract_annotations(out2)) == 1


def test_update_can_move_an_annotation_to_another_page(fixture_bytes):
    """The index is (page, xref); moving pages must not orphan the old object."""
    spec = {**HIGHLIGHT, "id": "traveller", "page": 0}
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(spec))
    out2, report = A.apply_annotation_ops(
        out, ops=[{"action": "update", "annotation": {**spec, "page": 2}}]
    )
    assert report["updated"] == 1
    items = A.extract_annotations(out2)
    assert len(items) == 1, "the annotation must not exist on both pages"
    assert items[0]["page"] == 2
    assert _pypdf_annot_count(out2, page=0) == 0
    assert _pypdf_annot_count(out2, page=2) == 1


def test_two_ops_on_the_same_id_in_one_batch_leave_one_annotation(fixture_bytes):
    """Autosave can compose an add and a later edit of the same draft."""
    out, report = A.apply_annotation_ops(
        fixture_bytes("text.pdf"),
        ops=[
            {"action": "add", "annotation": {**HIGHLIGHT, "id": "dup", "contents": "first"}},
            {"action": "update", "annotation": {**HIGHLIGHT, "id": "dup", "contents": "second"}},
        ],
    )
    items = A.extract_annotations(out)
    assert len(items) == 1
    assert items[0]["contents"] == "second"
    assert report["added"] == 1 and report["updated"] == 1


def test_delete_then_readd_in_one_batch(fixture_bytes):
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(HIGHLIGHT))
    out2, _ = A.apply_annotation_ops(
        out,
        ops=[
            {"action": "delete", "annotation": {"id": HIGHLIGHT["id"]}},
            {"action": "add", "annotation": {**HIGHLIGHT, "contents": "reborn"}},
        ],
    )
    items = A.extract_annotations(out2)
    assert len(items) == 1
    assert items[0]["contents"] == "reborn"


def test_foreign_annotations_are_never_clobbered(fixture_bytes):
    """An annotation we did not write (no addressable NM of ours) must survive a
    batch untouched — we only ever act on ids the client named."""
    doc = fitz.open(stream=fixture_bytes("text.pdf"), filetype="pdf")
    try:
        page = doc[0]
        foreign = page.add_rect_annot(fitz.Rect(50, 600, 200, 700))
        foreign.set_info(title="Some Other Tool")
        foreign.update()
        with_foreign = doc.tobytes()
    finally:
        doc.close()

    out, _ = A.apply_annotation_ops(with_foreign, ops=_add(HIGHLIGHT))
    items = A.extract_annotations(out)
    assert len(items) == 2
    assert any(a["author"] == "Some Other Tool" for a in items)

    out2, _ = A.apply_annotation_ops(
        out, ops=[{"action": "delete", "annotation": {"id": HIGHLIGHT["id"]}}]
    )
    remaining = A.extract_annotations(out2)
    assert [a["author"] for a in remaining] == ["Some Other Tool"]


def test_a_batch_of_thirty_is_one_pass(fixture_bytes):
    """Acceptance: a 30-annotation session saves as ONE job."""
    ops = [
        {"action": "add",
         "annotation": {**HIGHLIGHT, "id": f"h{i}",
                        "quads": [{"x": 0.05, "y": 0.02 + i * 0.03, "w": 0.4, "h": 0.02}]}}
        for i in range(30)
    ]
    out, report = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=ops)
    assert report["added"] == 30
    assert len(A.extract_annotations(out)) == 30
    assert _pypdf_annot_count(out) == 30


def test_annotations_land_on_the_requested_page(fixture_bytes):
    ops = [
        {"action": "add", "annotation": {**HIGHLIGHT, "id": "p0", "page": 0}},
        {"action": "add", "annotation": {**HIGHLIGHT, "id": "p2", "page": 2}},
    ]
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=ops)
    by_page = {a["id"]: a["page"] for a in A.extract_annotations(out)}
    assert by_page == {"p0": 0, "p2": 2}
    assert A.extract_annotations(out, pages=[2]) == [
        a for a in A.extract_annotations(out) if a["page"] == 2
    ]


# --------------------------------------------------------------------------- #
# Image stamps — the dual-path decision (phase-03 §"Backend/Endpoints")
# --------------------------------------------------------------------------- #
def _red_png() -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 40))
    pix.set_rect(pix.irect, (255, 0, 0))
    return pix.tobytes("png")


def test_image_stamp_renders_and_round_trips(fixture_bytes):
    """This is the golden test the plan says decides the image-stamp path on day
    one: the appearance-stream route both *renders* the image and keeps a real,
    addressable Stamp annotation — so the "flattened stamp" fallback, which
    would give up interop and addressability, is not needed."""
    spec = {"id": "img1", "page": 0, "type": "image_stamp",
            "rect": {"x": 0.6, "y": 0.2, "w": 0.25, "h": 0.1},
            "image_ref": "abcdef123456"}
    out, report = A.apply_annotation_ops(
        fixture_bytes("text.pdf"), ops=_add(spec), images={"abcdef123456": _red_png()}
    )
    assert report["added"] == 1

    # 1) it is a real annotation object, visible to another library
    assert _pypdf_annot_count(out) == 1
    assert _annots(out)[0][0] == "Stamp"

    # 2) it round-trips as an image_stamp, not a standard stamp
    item = A.extract_annotations(out)[0]
    assert item["type"] == "image_stamp"
    assert item["image_ref"] == "abcdef123456"

    # 3) the pixels are actually there
    doc = fitz.open(stream=out, filetype="pdf")
    page_rect = doc[0].rect
    doc.close()
    clip = fitz.Rect(0.62 * page_rect.width, 0.22 * page_rect.height,
                     0.82 * page_rect.width, 0.28 * page_rect.height)
    colors = _region_colors(out, 0, clip)
    assert any(c[0] > 200 and c[1] < 60 and c[2] < 60 for c in colors), colors


def test_image_stamp_without_its_image_is_a_validation_error(fixture_bytes):
    spec = {"id": "img2", "page": 0, "type": "image_stamp",
            "rect": {"x": 0.6, "y": 0.2, "w": 0.25, "h": 0.1},
            "image_ref": "missingref01"}
    with pytest.raises(InvalidParams):
        A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(spec), images={})


# --------------------------------------------------------------------------- #
# Flatten (bake)
# --------------------------------------------------------------------------- #
def test_flatten_bakes_markup_and_removes_the_objects(fixture_bytes):
    spec = {**HIGHLIGHT, "id": "bake-me", "color": "#ff0000", "opacity": 1.0,
            "quads": [{"x": 0.1, "y": 0.1, "w": 0.4, "h": 0.03}]}
    annotated, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(spec))

    doc = fitz.open(stream=annotated, filetype="pdf")
    rect = doc[0].rect
    doc.close()
    clip = fitz.Rect(0.12 * rect.width, 0.11 * rect.height,
                     0.45 * rect.width, 0.13 * rect.height)
    before = _region_colors(fixture_bytes("text.pdf"), 0, clip)

    flat = A.flatten_annotations(annotated, what="annotations")

    # annotation objects are gone …
    assert A.extract_annotations(flat) == []
    assert _pypdf_annot_count(flat) == 0
    # … but the ink is now in the page content
    after = _region_colors(flat, 0, clip)
    assert after != before
    assert any(c[0] > 200 and c[1] < 120 for c in after), after
    # and the underlying text is untouched
    doc = fitz.open(stream=flat, filetype="pdf")
    try:
        assert "Sample document" in doc[0].get_text()
    finally:
        doc.close()


def test_flatten_rejects_an_unknown_target(fixture_bytes):
    with pytest.raises(InvalidParams):
        A.flatten_annotations(fixture_bytes("text.pdf"), what="everything")


def test_flatten_form_leaves_annotations_alone(fixture_bytes):
    """`what=form` is phase 5's entry point; prove the split works now."""
    annotated, _ = A.apply_annotation_ops(fixture_bytes("form.pdf"), ops=_add(HIGHLIGHT))
    out = A.flatten_annotations(annotated, what="form")
    assert len(A.extract_annotations(out)) == 1
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert sum(1 for p in doc for _ in p.widgets()) == 0
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Geometry: rotated pages and RTL text
# --------------------------------------------------------------------------- #
def test_quads_are_correct_on_a_rotated_page(fixture_bytes):
    """§8: normalized coords are *visual* space, so a /Rotate 90 page needs no
    special-casing at the call site — the same numbers mean the same place."""
    data = fixture_bytes("rotated-90.pdf")
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        assert doc[0].rotation == 90
        pw, ph = doc[0].rect.width, doc[0].rect.height
    finally:
        doc.close()

    quad = {"x": 0.2, "y": 0.3, "w": 0.4, "h": 0.05}
    out, _ = A.apply_annotation_ops(
        data, ops=_add({**HIGHLIGHT, "id": "rot", "quads": [quad]})
    )
    got = A.extract_annotations(out)[0]["quads"][0]
    assert got["x"] == pytest.approx(quad["x"], abs=0.02)
    assert got["y"] == pytest.approx(quad["y"], abs=0.02)
    assert got["w"] == pytest.approx(quad["w"], abs=0.02)

    # and the mark lands inside the page it was asked for
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        pg = doc[0]
        annot_rect = next(pg.annots()).rect
        assert 0 <= annot_rect.x0 <= pw and 0 <= annot_rect.y0 <= ph
    finally:
        doc.close()


def test_hebrew_words_are_extractable_and_highlightable(fixture_bytes):
    """RTL fixture (phase-03 risk). Word rects come from the same engine that
    applies the annotation, so a Hebrew selection highlights what was selected."""
    data = fixture_bytes("hebrew-rtl.pdf")
    words = T.page_words(data, 0)
    assert words["has_text"] is True
    hebrew = [w for w in words["words"] if any("֐" <= ch <= "׿" for ch in w["t"])]
    assert len(hebrew) >= 5, [w["t"] for w in words["words"]][:20]
    assert any("שלום" in w["t"] for w in hebrew)

    target = hebrew[0]
    quad = {"x": target["x"], "y": target["y"], "w": target["w"], "h": target["h"]}
    out, report = A.apply_annotation_ops(
        data, ops=_add({**HIGHLIGHT, "id": "heb", "quads": [quad]})
    )
    assert report["added"] == 1
    got = A.extract_annotations(out)[0]["quads"][0]
    assert got["x"] == pytest.approx(quad["x"], abs=0.01)
    assert got["y"] == pytest.approx(quad["y"], abs=0.01)
    assert got["w"] == pytest.approx(quad["w"], abs=0.01)
    assert got["h"] == pytest.approx(quad["h"], abs=0.01)


def test_page_words_reading_order_indices(fixture_bytes):
    words = T.page_words(fixture_bytes("text.pdf"), 0)
    assert words["has_text"] is True
    assert words["words"][0]["t"] == "Sample"
    assert [w["i"] for w in words["words"][:3]] == [0, 1, 2]
    assert all(0 <= w["x"] <= 1 and 0 <= w["y"] <= 1 for w in words["words"])


def test_page_words_out_of_range(fixture_bytes):
    with pytest.raises(PageOutOfRange):
        T.page_words(fixture_bytes("text.pdf"), 99)


def test_page_words_on_a_scan_reports_no_text(fixture_bytes):
    words = T.page_words(fixture_bytes("scanned.pdf"), 0)
    assert words["has_text"] is False
    assert words["words"] == []


# --------------------------------------------------------------------------- #
# Guardrails
# --------------------------------------------------------------------------- #
def test_encrypted_document_is_refused(fixture_bytes):
    with pytest.raises(DocumentEncryptedError):
        A.apply_annotation_ops(fixture_bytes("encrypted.pdf"), ops=_add(HIGHLIGHT))
    with pytest.raises(DocumentEncryptedError):
        A.extract_annotations(fixture_bytes("encrypted.pdf"))


def test_unknown_action_is_rejected(fixture_bytes):
    with pytest.raises(InvalidParams):
        A.apply_annotation_ops(
            fixture_bytes("text.pdf"),
            ops=[{"action": "obliterate", "annotation": HIGHLIGHT}],
        )


def test_unknown_type_is_rejected(fixture_bytes):
    with pytest.raises(InvalidParams):
        A.apply_annotation_ops(
            fixture_bytes("text.pdf"),
            ops=_add({**HIGHLIGHT, "type": "hologram"}),
        )


def test_missing_id_is_rejected(fixture_bytes):
    bad = {k: v for k, v in HIGHLIGHT.items() if k != "id"}
    with pytest.raises(InvalidParams):
        A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(bad))


def test_empty_ops_is_rejected(fixture_bytes):
    with pytest.raises(InvalidParams):
        A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=[])


def test_page_out_of_range_is_rejected(fixture_bytes):
    with pytest.raises(PageOutOfRange):
        A.apply_annotation_ops(
            fixture_bytes("text.pdf"), ops=_add({**HIGHLIGHT, "page": 99})
        )


def test_markup_without_quads_is_rejected(fixture_bytes):
    bad = {k: v for k, v in HIGHLIGHT.items() if k != "quads"}
    with pytest.raises(InvalidParams):
        A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(bad))


def test_ink_without_strokes_is_rejected(fixture_bytes):
    with pytest.raises(InvalidParams):
        A.apply_annotation_ops(
            fixture_bytes("text.pdf"),
            ops=_add({"id": "i", "page": 0, "type": "ink", "ink": []}),
        )


def test_unknown_stamp_name_is_rejected(fixture_bytes):
    with pytest.raises(InvalidParams):
        A.apply_annotation_ops(
            fixture_bytes("text.pdf"),
            ops=_add({"id": "s", "page": 0, "type": "stamp",
                      "rect": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05},
                      "stamp_name": "Superb"}),
        )


# --------------------------------------------------------------------------- #
# Colors
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "value,expected",
    [("#ff0000", (1.0, 0.0, 0.0)), ("#0f0", (0.0, 1.0, 0.0)),
     ("000000", (0.0, 0.0, 0.0)), ([0.5, 0.5, 0.5], (0.5, 0.5, 0.5))],
)
def test_parse_color(value, expected):
    got = A.parse_color(value)
    assert got == pytest.approx(expected, abs=0.004)


def test_parse_color_none_passes_through():
    assert A.parse_color(None) is None


@pytest.mark.parametrize("value", ["#gg0000", "#1234", [0.1, 0.2]])
def test_parse_color_rejects_junk(value):
    with pytest.raises(InvalidParams):
        A.parse_color(value)


def test_format_color_round_trip():
    assert A.format_color([1.0, 0.0, 0.0]) == "#ff0000"
    assert A.format_color(None) is None
    assert A.format_color([0.0]) == "#000000"
