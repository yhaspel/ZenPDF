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


def test_a_client_cannot_choose_the_author(fixture_bytes):
    """§3's "display name, or Guest" must be a *server* fact.

    `author` is accepted on the wire so an extracted annotation round-trips
    through an update unchanged — but honouring it would let any caller stamp
    any name into a file, and the guest invariant would be client-controlled.
    """
    out, _ = A.apply_annotation_ops(
        fixture_bytes("text.pdf"),
        ops=_add({**HIGHLIGHT, "author": "Jane Doe, General Counsel"}),
        author="Guest",
    )
    assert A.extract_annotations(out)[0]["author"] == "Guest"


def test_editing_someone_elses_annotation_keeps_their_name(fixture_bytes):
    """Acrobat behaviour, and the honest one: editing a comment does not make
    it yours."""
    first, _ = A.apply_annotation_ops(
        fixture_bytes("text.pdf"), ops=_add(HIGHLIGHT), author="Alice"
    )
    second, _ = A.apply_annotation_ops(
        first,
        ops=[{"action": "update", "annotation": {**HIGHLIGHT, "contents": "edited"}}],
        author="Bob",
    )
    item = A.extract_annotations(second)[0]
    assert item["author"] == "Alice"
    assert item["contents"] == "edited"


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


def test_a_batch_of_thirty_is_one_pass_and_well_under_five_seconds(fixture_bytes):
    """Acceptance: a 30-annotation session saves as ONE job, <5 s on `default`.

    The time is measured, not inferred from how fast the suite happens to run.
    """
    import time

    ops = [
        {"action": "add",
         "annotation": {**HIGHLIGHT, "id": f"h{i}",
                        "quads": [{"x": 0.05, "y": 0.02 + i * 0.03, "w": 0.4, "h": 0.02}]}}
        for i in range(30)
    ]
    started = time.monotonic()
    out, report = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=ops)
    elapsed = time.monotonic() - started

    assert report["added"] == 30
    assert len(A.extract_annotations(out)) == 30
    assert _pypdf_annot_count(out) == 30
    # Generous by design: this asserts the op is not accidentally quadratic, not
    # that a particular machine is fast.
    assert elapsed < 5.0, f"30-annotation batch took {elapsed:.2f}s"


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


def test_stamps_keep_the_rect_the_user_drew(fixture_bytes):
    """`add_stamp_annot` aspect-fits `/Rect` to the built-in appearance — a
    190×80 box came back 190×50 for "Approved" — so the mark the user placed
    was silently reshaped, and an image stamp's pixels were stretched into the
    *reshaped* box (measured live: a 3:2 drag saved as roughly 4:1). The rect
    is now set back after the appearance work, which a viewer honours by
    scaling the appearance onto it: the stamp fills the box that was drawn."""
    drawn = {"x": 0.2, "y": 0.3, "w": 0.3, "h": 0.2}  # nothing like 4:1
    stamp = {"id": "st-rect", "page": 0, "type": "stamp", "rect": dict(drawn),
             "stamp_name": "Approved", "color": "#332d24"}
    image = {"id": "img-rect", "page": 1, "type": "image_stamp",
             "rect": dict(drawn), "image_ref": "abcdef123456"}
    # A later op on a *different* page is the regression trigger: loading the
    # next page makes MuPDF re-synthesise any stamp left dirty, which re-fits
    # the rect all over again — `set_rect` restored it and this op undid it.
    note = {"id": "after", "page": 2, "type": "note",
            "rect": {"x": 0.1, "y": 0.1, "w": 0.02, "h": 0.02}, "contents": "x"}
    out, report = A.apply_annotation_ops(
        fixture_bytes("text.pdf"),
        ops=[{"action": "add", "annotation": stamp},
             {"action": "add", "annotation": image},
             {"action": "add", "annotation": note}],
        images={"abcdef123456": _red_png()},
    )
    assert report["added"] == 3

    for got in A.extract_annotations(out):
        if got["id"] == "after":
            continue
        for key, want in drawn.items():
            assert got["rect"][key] == pytest.approx(want, abs=1e-3), (
                got["type"], key)

    # And the pixels really moved with the rect: red in the drawn box's middle
    # on the image's page, not only in a squashed band.
    doc = fitz.open(stream=out, filetype="pdf")
    page_rect = doc[1].rect
    doc.close()
    clip = fitz.Rect(0.25 * page_rect.width, 0.32 * page_rect.height,
                     0.45 * page_rect.width, 0.48 * page_rect.height)
    colors = _region_colors(out, 1, clip)
    assert any(c[0] > 200 and c[1] < 60 and c[2] < 60 for c in colors), colors


def test_a_stamps_comment_survives_the_appearance_builder(fixture_bytes):
    """`annot.update()` writes the stamp's own name into `/Contents`, so a
    comment typed on a stamp came back as "Approved" after every save — and so
    did every *image* stamp's comment, which is stranger. The user's contents
    are re-asserted after the appearance work; an empty comment stays empty."""
    with_comment = {"id": "st-c", "page": 0, "type": "stamp",
                    "rect": {"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.08},
                    "stamp_name": "Draft", "contents": "second pass, please"}
    empty = {"id": "st-e", "page": 0, "type": "stamp",
             "rect": {"x": 0.1, "y": 0.3, "w": 0.3, "h": 0.08},
             "stamp_name": "Approved"}
    image = {"id": "img-c", "page": 0, "type": "image_stamp",
             "rect": {"x": 0.1, "y": 0.5, "w": 0.3, "h": 0.1},
             "image_ref": "abcdef123456", "contents": "the good logo"}
    out, _ = A.apply_annotation_ops(
        fixture_bytes("text.pdf"),
        ops=[{"action": "add", "annotation": with_comment},
             {"action": "add", "annotation": empty},
             {"action": "add", "annotation": image}],
        images={"abcdef123456": _red_png()},
    )
    got = {a["id"]: a for a in A.extract_annotations(out)}
    assert got["st-c"]["contents"] == "second pass, please"
    assert got["st-e"]["contents"] == ""
    assert got["img-c"]["contents"] == "the good logo"


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
def _ink_bbox(data: bytes, page: int, predicate) -> tuple[float, float, float, float]:
    """Where matching pixels actually land, as fractions of the *displayed* page."""
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        pm = doc[page].get_pixmap()
        xs, ys = [], []
        for y in range(0, pm.height, 2):
            for x in range(0, pm.width, 2):
                if predicate(pm.pixel(x, y)):
                    xs.append(x / pm.width)
                    ys.append(y / pm.height)
    finally:
        doc.close()
    assert xs, "nothing matched — the mark did not render at all"
    return (min(xs), min(ys), max(xs), max(ys))


def test_a_mark_on_a_rotated_page_renders_where_it_was_placed(fixture_bytes):
    """The regression a round-trip test cannot see.

    `page.rect` is rotation-applied but `add_*_annot` takes the page's
    *unrotated* space, so before the de-rotation was added a mark placed at the
    top-left of a /Rotate 90 page was written to the top-right — and extraction
    read it back through the same wrong transform, so create→extract agreed
    perfectly while the file disagreed with both. Only the rendered pixels can
    tell you, so this test looks at them.
    """
    spec = {"id": "rot-place", "page": 0, "type": "square",
            "rect": {"x": 0.05, "y": 0.05, "w": 0.20, "h": 0.20},
            "color": "#ff0000", "width": 4, "opacity": 1.0}
    out, _ = A.apply_annotation_ops(fixture_bytes("rotated-90.pdf"), ops=_add(spec))

    x0, y0, x1, y1 = _ink_bbox(
        out, 0, lambda c: c[0] > 150 and c[1] < 100 and c[2] < 100
    )
    assert x0 == pytest.approx(0.05, abs=0.02), f"drawn at x {x0:.3f}, expected 0.05"
    assert y0 == pytest.approx(0.05, abs=0.02), f"drawn at y {y0:.3f}, expected 0.05"
    assert x1 == pytest.approx(0.25, abs=0.02)
    assert y1 == pytest.approx(0.25, abs=0.02)


def test_the_same_placement_is_unaffected_on_an_unrotated_page(fixture_bytes):
    """De-rotation must be a no-op when there is no rotation."""
    spec = {"id": "flat-place", "page": 0, "type": "square",
            "rect": {"x": 0.05, "y": 0.05, "w": 0.20, "h": 0.20},
            "color": "#ff0000", "width": 4, "opacity": 1.0}
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(spec))
    x0, y0, _, _ = _ink_bbox(out, 0, lambda c: c[0] > 150 and c[1] < 100 and c[2] < 100)
    assert x0 == pytest.approx(0.05, abs=0.02)
    assert y0 == pytest.approx(0.05, abs=0.02)


def test_word_boxes_on_a_rotated_page_cover_the_visible_text(fixture_bytes):
    """The overlay's text layer must sit on top of the text the reader sees.

    `get_text("words")` reports the unrotated space, so without the rotation the
    transparent word grid landed a quarter turn away and text markup attached to
    nothing on any rotated page.
    """
    data = fixture_bytes("rotated-90.pdf")
    words = T.page_words(data, 0)
    assert words["has_text"] is True
    assert words["rotation"] == 90

    wx0 = min(w["x"] for w in words["words"])
    wy0 = min(w["y"] for w in words["words"])
    wx1 = max(w["x"] + w["w"] for w in words["words"])
    wy1 = max(w["y"] + w["h"] for w in words["words"])

    # Where the glyphs actually are on screen.
    ix0, iy0, ix1, iy1 = _ink_bbox(data, 0, lambda c: sum(c) < 400)

    assert wx0 <= ix0 + 0.02 and wx1 >= ix1 - 0.02, (
        f"word grid x {wx0:.3f}..{wx1:.3f} does not cover ink x {ix0:.3f}..{ix1:.3f}"
    )
    assert wy0 <= iy0 + 0.02 and wy1 >= iy1 - 0.02, (
        f"word grid y {wy0:.3f}..{wy1:.3f} does not cover ink y {iy0:.3f}..{iy1:.3f}"
    )


def test_a_rect_that_runs_off_the_page_is_a_validation_error(fixture_bytes):
    """A note dropped near the right edge produces `x + w > 1`, which the JSON
    Schema cannot express (it bounds x and w separately). It must still surface
    as `validation_error` naming the problem, not as a generic `engine_error`
    that fails a 30-annotation batch with "Operation failed"."""
    with pytest.raises(InvalidParams) as exc:
        A.apply_annotation_ops(
            fixture_bytes("text.pdf"),
            ops=_add({"id": "edge", "page": 0, "type": "note",
                      "rect": {"x": 0.99, "y": 0.5, "w": 0.025, "h": 0.02}}),
        )
    assert "rect" in str(exc.value)


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


# --------------------------------------------------------------------------- #
# Text boxes: one layout, drawn twice (design contract §3 "Text on the page";
# `docs/archived/2026-09-25-annotate-text-PROMPT.md`). The client decides the lines and sizes the
# box from them; the file draws exactly those lines, in Arimo, at the baselines
# `A.text_baseline` computes — the formula the browser's CSS reproduces.
# --------------------------------------------------------------------------- #
def _blank(width: float = 595, height: float = 842, rotate: int = 0,
           pages: int = 1) -> bytes:
    doc = fitz.open()
    for _ in range(pages):
        page = doc.new_page(width=width, height=height)
        if rotate:
            page.set_rotation(rotate)
    try:
        return doc.tobytes()
    finally:
        doc.close()


def _text_box(nm: str, x_pt: float, y_pt: float, lines: list[str], size: float,
              *, page: int = 0, page_w: float = 595, page_h: float = 842,
              color: str = "#000000") -> dict:
    """What the client sends: the rect is the lines' own size — widest line by
    lines × 1.2 × size — rounded to the wire's six decimals."""
    face = A._text_font()
    w = max([face.text_length(line, fontsize=size) for line in lines] + [1.0])
    h = len(lines) * A.TEXT_LINE_HEIGHT * size
    return {
        "id": nm, "page": page, "type": "free_text",
        "rect": {"x": round(x_pt / page_w, 6), "y": round(y_pt / page_h, 6),
                 "w": round(w / page_w, 6), "h": round(h / page_h, 6)},
        "lines": lines, "contents": "\n".join(lines),
        "font_size": size, "color": color, "width": 0,
    }


def _spans(data: bytes, page: int = 0) -> list[dict]:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        pg = doc[page]
        return [s for b in pg.get_text("dict")["blocks"] for ln in b.get("lines", [])
                for s in ln["spans"]]
    finally:
        doc.close()


def test_text_font_is_arimo_and_covers_hebrew():
    """The face both sides use has to carry every glyph a Hebrew form needs —
    a missing glyph is a fallback font, and a fallback font is a shift."""
    from fontTools.ttLib import TTFont

    font = TTFont(A.TEXT_FONT_PATH)
    cmap = font.getBestCmap()
    assert font["name"].getDebugName(1) == "Arimo"
    assert all(cp in cmap for cp in range(0x05D0, 0x05EB)), "Hebrew letters"
    assert all(cp in cmap for cp in range(0x20, 0x7F)), "printable ASCII"
    # The metrics the CSS pins with ascent-/descent-override.
    assert font["head"].unitsPerEm == 2048
    assert font["hhea"].ascent == 1854 and font["hhea"].descent == -434
    assert A.TEXT_ASCENT == 1854 / 2048 and A.TEXT_DESCENT == 434 / 2048


# "Same bytes" — that the frontend serves this very file — is checked by
# `infra/test.sh`, not here: this suite runs in a container that mounts
# backend/ only, so a test for it could only skip, and the gate fails on that.


@pytest.mark.parametrize("size", [9, 12, 14, 24])
@pytest.mark.parametrize("count", [1, 2, 5])
def test_text_baselines_are_the_formula(size, count):
    lines = [f"Line {i + 1} AVAWAY fi fl" for i in range(count)]
    x, y = 72.0, 100.0
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(_text_box("tb", x, y, lines, size)))
    spans = [s for s in _spans(out) if s["text"].strip()]
    assert [s["text"] for s in spans] == lines
    for i, span in enumerate(spans):
        assert span["font"].startswith("Arimo")
        assert span["size"] == pytest.approx(size, abs=0.01)
        # six-decimal wire rounding of the rect is < 0.001 pt on a 842 pt page
        assert span["origin"][0] == pytest.approx(x, abs=0.01)
        assert span["origin"][1] == pytest.approx(y + A.text_baseline(i, size), abs=0.01)


def test_text_box_rect_is_the_rect_the_client_sent():
    spec = _text_box("tb", 100, 52, ["Yuval Haspel"], 12)
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    [item] = A.extract_annotations(out)
    assert item["rect"] == spec["rect"]
    assert item["lines"] == ["Yuval Haspel"]
    assert item["contents"] == "Yuval Haspel"
    assert item["font_size"] == 12


@pytest.mark.parametrize("size", [9, 12, 24])
def test_no_glyph_is_clipped(size):
    """Every span sits inside the box: the box is its text's size, so nothing
    reaches the edge that the appearance's BBox would cut."""
    lines = ["12 Herzl St., Petah Tikva", "jg Qy AVAWAY", "רחוב הרצל 12, פתח תקווה"]
    spec = _text_box("tb", 60, 200, lines, size)
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    rect = spec["rect"]
    x0, y0 = rect["x"] * 595, rect["y"] * 842
    x1, y1 = x0 + rect["w"] * 595, y0 + rect["h"] * 842
    spans = [s for s in _spans(out) if s["text"].strip()]
    assert len(spans) == 3
    for span in spans:
        bx0, by0, bx1, by1 = span["bbox"]
        assert bx0 >= x0 - 0.5 and bx1 <= x1 + 0.5, (span["text"], span["bbox"], (x0, x1))
        assert by0 >= y0 - 0.5 and by1 <= y1 + 0.5, (span["text"], span["bbox"], (y0, y1))


def test_hebrew_is_right_aligned_and_extracts_in_logical_spelling():
    lines = ["רחוב הרצל 12, פתח תקווה", "דירה 4"]
    spec = _text_box("he", 125, 150, lines, 14)
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    right = (spec["rect"]["x"] + spec["rect"]["w"]) * 595
    spans = [s for s in _spans(out) if s["text"].strip()]
    assert len(spans) == 2
    for span in spans:
        # Right edge of every line on the box's right edge (RTL = start is right).
        assert span["bbox"][2] == pytest.approx(right, abs=0.6)
    # The short second line is right-aligned, not left.
    assert spans[1]["bbox"][0] > spans[0]["bbox"][0] + 50
    text = " ".join(s["text"] for s in spans)
    # Each word reads in logical order (a reversed word would not match). The
    # position of "12," relative to the words is the extractor's own bidi
    # guess and is not asserted.
    for word in ("רחוב", "הרצל", "פתח", "תקווה", "דירה"):
        assert word in text, (word, text)
    [item] = A.extract_annotations(out)
    assert item["lines"] == lines


def test_bidi_visual_order_matches_the_browser():
    """What the file draws is the UAX #9 visual order for an RTL paragraph —
    digits stay left-to-right inside the right-to-left line."""
    from bidi.algorithm import get_display

    visual = get_display("רחוב הרצל 12, פתח תקווה", base_dir="R")
    assert "12" in visual and "21" not in visual
    assert visual.endswith("רחוב"[::-1])  # the first word lands at the right


def test_paragraph_direction_is_the_first_strong_character():
    assert A.paragraph_is_rtl("שלום world")
    assert not A.paragraph_is_rtl("world שלום")
    assert A.paragraph_is_rtl("12, רחוב")  # digits are weak
    assert not A.paragraph_is_rtl("")
    assert not A.paragraph_is_rtl("12 ,")


@pytest.mark.parametrize("text, rtl", [
    # The same table is in `core/text-layout.spec.ts`: the screen's `dir` and
    # the file's alignment are one decision, made by one rule on both sides.
    ("‏12 Main St", True),      # RLM decides
    ("‎שלום", False),           # LRM decides
    ("١٢ items", False),             # Arabic-Indic digits are weak
    ("۱۲ items", False),             # so are the extended ones
    ("﻿Hello", False),          # a BOM is a format character
    ("ָשלום", True),            # a point is a mark; the letter decides
    ("𞤀𞤁 12 abc", True),             # Adlam, a supplementary RTL script
    ("Ωmega", False),
    # Where the old Bidi_Class rule differed: a modifier *letter* (bidi ON)
    # decides, a Cyrillic thousands sign (bidi L, a symbol) does not.
    ("\u02b9א", False),
    ("\u0482א", True),
])
def test_paragraph_direction_matches_the_clients_rule(text, rtl):
    assert A.paragraph_is_rtl(text) is rtl


@pytest.mark.parametrize("rotate", [90, 180, 270])
def test_text_box_reads_upright_on_a_rotated_page(rotate):
    """Placed on a /Rotate N page the lines read the way the reader sees the
    page: wide and short, not turned a quarter (or half) turn."""
    lines = ["Rotated page text", "second line"]
    turned = _blank(595, 842, rotate=rotate)
    doc = fitz.open(stream=turned, filetype="pdf")
    dw, dh = doc[0].rect.width, doc[0].rect.height
    doc.close()
    spec = _text_box("rt", 80, 120, lines, 14, page_w=dw, page_h=dh)
    out, _ = A.apply_annotation_ops(turned, ops=_add(spec))
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        pm = doc[0].get_pixmap(annots=True)
        xs, ys = [], []
        for y in range(pm.height):
            for x in range(pm.width):
                if sum(pm.pixel(x, y)[:3]) < 384:
                    xs.append(x / pm.width * dw)
                    ys.append(y / pm.height * dh)
    finally:
        doc.close()
    assert xs, "nothing rendered"
    # Upright: ink is wider than tall, and starts at the box's top-left.
    assert max(xs) - min(xs) > 2 * (max(ys) - min(ys))
    assert min(xs) == pytest.approx(80, abs=2)
    assert min(ys) == pytest.approx(120 + A.text_baseline(0, 14) - 14 * 0.75, abs=3)
    [item] = A.extract_annotations(out)
    for k in ("x", "y", "w", "h"):
        assert item["rect"][k] == pytest.approx(spec["rect"][k], abs=2e-6)


def test_a_trailing_op_on_another_page_does_not_undo_the_appearance():
    """The 2026-08-28 lesson: MuPDF re-synthesises *dirty* annotations when a
    later op loads another page. The text appearance is written with raw xref
    keys after `update()`, so it has to survive a trailing op elsewhere."""
    ops = _add(_text_box("tb", 72, 100, ["Survives the batch"], 12))
    ops += _add({"id": "sq", "page": 1, "type": "square",
                 "rect": {"x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}})
    out, report = A.apply_annotation_ops(_blank(pages=2), ops=ops)
    assert report["added"] == 2
    spans = [s for s in _spans(out) if s["text"].strip()]
    assert [s["font"][:5] for s in spans] == ["Arimo"]
    assert spans[0]["origin"][1] == pytest.approx(100 + A.text_baseline(0, 12), abs=0.01)


def test_updating_a_text_box_redraws_it_from_the_new_lines():
    first = _text_box("tb", 72, 100, ["before"], 12)
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(first))
    second = _text_box("tb", 72, 100, ["after, and", "longer"], 12)
    out, report = A.apply_annotation_ops(out, ops=[{"action": "update", "annotation": second}])
    assert report["updated"] == 1
    assert [s["text"] for s in _spans(out) if s["text"].strip()] == ["after, and", "longer"]
    [item] = A.extract_annotations(out)
    assert item["lines"] == ["after, and", "longer"]


def test_a_foreign_free_text_round_trips_untouched():
    """A FreeText made by someone else (no /ZenLines) keeps its own appearance
    while it is not edited — and reads back without `lines`."""
    doc = fitz.open()
    page = doc.new_page()
    annot = page.add_freetext_annot(fitz.Rect(50, 50, 250, 90), "Foreign note", fontsize=11)
    annot.set_info(content="Foreign note")
    annot.update()
    ap_before = doc.xref_stream(int(doc.xref_get_key(annot.xref, "AP/N")[1].split()[0]))
    data = doc.tobytes()
    doc.close()

    out, _ = A.apply_annotation_ops(data, ops=_add(_text_box("mine", 72, 300, ["Mine"], 12)))
    items = {i["contents"]: i for i in A.extract_annotations(out)}
    assert "lines" not in items["Foreign note"]
    assert items["Mine"]["lines"] == ["Mine"]
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        pg = doc[0]
        foreign = next(a for a in pg.annots() if (a.info or {}).get("content") == "Foreign note")
        ap_after = doc.xref_stream(int(doc.xref_get_key(foreign.xref, "AP/N")[1].split()[0]))
    finally:
        doc.close()
    assert ap_after == ap_before


def test_free_text_without_lines_keeps_the_stock_appearance(fixture_bytes):
    """An API client that sends no `lines` gets MuPDF's own layout, as before."""
    spec = {"id": "old", "page": 0, "type": "free_text",
            "rect": {"x": 0.1, "y": 0.1, "w": 0.4, "h": 0.05},
            "contents": "No lines sent", "font_size": 12}
    out, _ = A.apply_annotation_ops(fixture_bytes("text.pdf"), ops=_add(spec))
    [item] = [i for i in A.extract_annotations(out) if i["id"] == "old"]
    assert "lines" not in item


def test_text_font_is_subset_on_save():
    """A full Arimo is ~300 KB; a saved file carries only the glyphs it uses."""
    out, _ = A.apply_annotation_ops(
        _blank(), ops=_add(_text_box("tb", 72, 100, ["Small file"], 12)))
    assert len(out) < 40_000, len(out)


def test_lines_must_be_strings():
    spec = _text_box("tb", 72, 100, ["ok"], 12)
    spec["lines"] = ["ok", 3]
    with pytest.raises(InvalidParams):
        A.apply_annotation_ops(_blank(), ops=_add(spec))


def test_empty_lines_are_blank_lines_not_errors():
    spec = _text_box("tb", 72, 100, ["first", "", "third"], 12)
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    spans = [s for s in _spans(out) if s["text"].strip()]
    assert [s["text"] for s in spans] == ["first", "third"]
    assert spans[1]["origin"][1] == pytest.approx(100 + A.text_baseline(2, 12), abs=0.01)


def test_text_geometry_is_pinned_to_the_numbers_the_browser_uses():
    """The tests above measure the file against `A.text_baseline`; this pins
    `A.text_baseline` itself. The browser reproduces these numbers from CSS
    (`line-height: 1.2`, the ascent/descent overrides) and
    `core/text-layout.spec.ts` pins the same ones — so the engine cannot drift
    from the screen without failing here."""
    assert A.TEXT_LINE_HEIGHT == 1.2
    assert A.text_baseline(0, 12) == pytest.approx(11.36015625, abs=1e-9)
    assert A.text_baseline(1, 12) - A.text_baseline(0, 12) == pytest.approx(14.4, abs=1e-9)
    # The spec's worked example: a box at y = 52 puts line 1 on 63.36.
    assert 52 + A.text_baseline(0, 12) == pytest.approx(63.36, abs=0.001)


def test_text_is_drawn_in_the_colour_sent():
    out, _ = A.apply_annotation_ops(
        _blank(), ops=_add(_text_box("tb", 72, 100, ["Red text"], 12, color="#FF0000")))
    [span] = [s for s in _spans(out) if s["text"].strip()]
    assert span["color"] == 0xFF0000


@pytest.mark.parametrize("crop", ["[0 0 595 842]", "[50 50 545 792]"])
def test_an_inherited_cropbox_does_not_move_the_appearance(crop):
    """/CropBox is inheritable. A scratch page that picked one up from /Pages
    baked the offset into the appearance and drew every glyph outside its
    BBox — the box saved blank, or shifted and cut."""
    doc = fitz.open(stream=_blank(), filetype="pdf")
    pages_xref = int(doc.xref_get_key(doc.pdf_catalog(), "Pages")[1].split()[0])
    doc.xref_set_key(pages_xref, "CropBox", crop)
    doc.xref_set_key(doc[0].xref, "CropBox", "null")
    dw, dh = doc[0].rect.width, doc[0].rect.height
    data = doc.tobytes()
    doc.close()
    spec = _text_box("tb", 80, 120, ["Inherited crop", "second line"], 14, page_w=dw, page_h=dh)
    out, _ = A.apply_annotation_ops(data, ops=_add(spec))
    spans = [s for s in _spans(out) if s["text"].strip()]
    assert [s["text"] for s in spans] == ["Inherited crop", "second line"]
    for i, span in enumerate(spans):
        assert span["origin"][0] == pytest.approx(80, abs=0.01)
        assert span["origin"][1] == pytest.approx(120 + A.text_baseline(i, 14), abs=0.01)


def _page_with(rotate: int = 0, crop: tuple | None = None) -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    if crop:
        page.set_cropbox(fitz.Rect(*crop))
    page.set_rotation(rotate)
    data = doc.tobytes()
    doc.close()
    return data


def _file_box(data: bytes) -> fitz.Rect:
    """The first annotation's /Rect as the page is displayed."""
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        page = doc[0]
        return next(page.annots()).rect * page.rotation_matrix
    finally:
        doc.close()


@pytest.mark.parametrize("crop", [None, (50, 60, 545, 792)])
@pytest.mark.parametrize("rotate", [0, 90])
@pytest.mark.parametrize("border", [1, 2])
def test_a_bordered_text_box_keeps_the_rect_and_size_sent(border, rotate, crop):
    """MuPDF grows a bordered FreeText's /Rect by half the border each side; a
    viewer then stretched the lines (drawn at the box's size) onto it. The
    correction is made relative to MuPDF's own rect — converting the whole
    rect lost the CropBox origin on a rotated page and moved the box."""
    data = _page_with(rotate, crop)
    doc = fitz.open(stream=data, filetype="pdf")
    dw, dh = doc[0].rect.width, doc[0].rect.height
    doc.close()
    spec = {**_text_box("tb", 100, 200, ["Bordered box", "two lines"], 12,
                        page_w=dw, page_h=dh), "width": border}
    out, _ = A.apply_annotation_ops(data, ops=_add(spec))
    [item] = A.extract_annotations(out)
    for k in ("x", "y", "w", "h"):
        assert item["rect"][k] == pytest.approx(spec["rect"][k], abs=2e-6)
    spans = [s for s in _spans(out) if s["text"].strip()]
    assert len(spans) == 2
    for i, span in enumerate(spans):
        assert span["size"] == pytest.approx(12, abs=0.01)
        if rotate == 0:
            assert span["origin"][1] == pytest.approx(200 + A.text_baseline(i, 12), abs=0.01)


def test_lines_another_editor_made_stale_are_dropped():
    """An editor that changes /Contents and redraws the box can keep a key it
    does not know. Stale lines would show the old text and, on the next save,
    draw it back over the new — so they are read only while they still spell
    /Contents, and the box is otherwise treated as someone else's."""
    out, _ = A.apply_annotation_ops(
        _blank(), ops=_add(_text_box("tb", 72, 100, ["Meet at 10:00"], 12)))
    doc = fitz.open(stream=out, filetype="pdf")
    page = doc[0]
    annot = next(page.annots())
    annot.set_info(content="Meet at 14:30 instead")
    annot.update()
    edited = doc.tobytes()
    del annot, page
    doc.close()
    [item] = A.extract_annotations(edited)
    assert item["contents"] == "Meet at 14:30 instead"
    assert "lines" not in item
    # …while the client's own breaks, and the whitespace dropped at them, are fine.
    spec = _text_box("tb", 72, 100, ["Signed on behalf of the", "company"], 12)
    spec["contents"] = "Signed on behalf of the company"
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    [item] = A.extract_annotations(out)
    assert item["lines"] == ["Signed on behalf of the", "company"]


@pytest.mark.parametrize("lines, rtl", [
    (["مرحبا بالعالم", "شكرا"], True),    # Arabic letters join
    (["שָׁלוֹם עוֹלָם", "דִּירָה"], True),   # Hebrew points are positioned marks
    (["नमस्ते दुनिया"], False),           # Devanagari conjuncts
])
def test_text_that_needs_shaping_keeps_the_stock_appearance(lines, rtl):
    """TextWriter draws one glyph per character with no shaping: Arabic came
    out as disconnected letters, points between the letters they belong to.
    Such a box keeps MuPDF's own appearance, which shapes — stored without
    lines, like any FreeText this editor did not draw — and an RTL paragraph
    is right-aligned there, as the editor shows it."""
    spec = _text_box("tb", 72, 100, lines, 14)
    spec["rect"]["w"] = 0.4  # the client's measure of these is not Arimo's
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    [item] = A.extract_annotations(out)
    assert "lines" not in item
    assert item["contents"] == "\n".join(lines)
    spans = [s for s in _spans(out) if s["text"].strip()]
    assert spans and not [s for s in spans if s["font"].startswith("Arimo")]
    if rtl:
        right = 72 + 0.4 * 595
        assert max(s["bbox"][2] for s in spans) == pytest.approx(right, abs=1.5)


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
@pytest.mark.parametrize("text, browser_em, rtl", [
    ("Done ✅", 1.0, False),         # Chrome's emoji is 1 em; the file's is wider
    ("Signed ✔ 12/05", 0.846, False),
    ("שלום ✅", 1.0, True),
    ("Done ✔\ufe0f", 0.846, False),  # a variation selector draws nothing
])
def test_a_fallback_glyph_wider_than_the_browsers_grows_the_drawing(text, browser_em, rtl,
                                                                      rotate):
    """A character Arimo lacks is drawn in a MuPDF fallback face, which can be
    wider than the browser's — and the box, the client's measure, cut the end
    of the line off. The drawing grows toward the line's end instead (right for
    LTR, left for RTL, along the *displayed* line on a turned page), without
    stretching a glyph; and the client reads back the box it sent."""
    data = _page_with(rotate)
    doc = fitz.open(stream=data, filetype="pdf")
    dw, dh = doc[0].rect.width, doc[0].rect.height
    doc.close()
    face = A._text_font()
    size, x, y = 14, 100.0, 200.0
    w = sum(face.text_length(c, fontsize=size) for c in text if face.has_glyph(ord(c))) \
        + browser_em * size
    spec = _text_box("tb", x, y, [text], size, page_w=dw, page_h=dh)
    spec["rect"]["w"] = round(w / dw, 6)
    out, _ = A.apply_annotation_ops(data, ops=_add(spec))
    [item] = A.extract_annotations(out)
    assert item["lines"] == [text]
    for k in ("x", "y", "w", "h"):
        assert item["rect"][k] == pytest.approx(spec["rect"][k], abs=2e-6)
    box = _file_box(out)
    if rtl:
        assert box.x1 == pytest.approx(x + w, abs=0.01) and box.x0 < x - 0.5
    else:
        assert box.x0 == pytest.approx(x, abs=0.01) and box.x1 > x + w + 0.5
    assert box.y0 == pytest.approx(y, abs=0.01)
    assert box.height == pytest.approx(1.2 * size, abs=0.01)
    for span in (s for s in _spans(out) if s["text"].strip()):
        assert span["size"] == pytest.approx(size, abs=0.01)
        if rotate == 0:
            assert span["bbox"][0] >= box.x0 - 0.5 and span["bbox"][2] <= box.x1 + 0.5, span


@pytest.mark.parametrize("text, x_pt, rtl", [
    ("Signed ✔", None, False),   # flush against the right edge
    ("אושר ✅", 0.0, True),      # against the left edge, growing left
])
def test_growth_never_leaves_the_page(text, x_pt, rtl):
    """A rect grown past the page is one no reader takes: the annotation list
    failed on it. The drawing stops at the edge — nothing past it is seen."""
    face = A._text_font()
    size = 14
    w = sum(face.text_length(c, fontsize=size) for c in text if face.has_glyph(ord(c))) + size
    spec = _text_box("tb", 0, 300, [text], size)
    spec["rect"]["w"] = round(w / 595, 6)
    spec["rect"]["x"] = round(1 - spec["rect"]["w"], 6) if x_pt is None else 0.0
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    [item] = A.extract_annotations(out)
    assert item["rect"] == spec["rect"]
    box = _file_box(out)
    assert box.x0 >= -0.01 and box.x1 <= 595.01


def test_an_rtl_box_re_sent_as_read_does_not_move():
    """The client re-lays a box from the rect it read, with its own width. Had
    it been handed the grown rect, an RTL box would creep left by the growth
    on every edit."""
    face = A._text_font()
    size, text = 14, "אושר ✅"
    w = sum(face.text_length(c, fontsize=size) for c in text if face.has_glyph(ord(c))) + size
    spec = _text_box("tb", 240, 300, [text], size)
    spec["rect"]["w"] = round(w / 595, 6)
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    first = _file_box(out)
    for _ in range(3):
        [item] = A.extract_annotations(out)
        out, _ = A.apply_annotation_ops(
            out, ops=[{"action": "update", "annotation": {**spec, "rect": item["rect"]}}])
    assert _file_box(out) == first


def test_a_trailing_space_does_not_grow_the_box():
    spec = _text_box("tb", 72, 100, ["Hello "], 12)
    spec["rect"]["w"] = round(A._text_font().text_length("Hello", fontsize=12) / 595, 6)
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    [item] = A.extract_annotations(out)
    assert item["rect"] == spec["rect"]


def test_an_rtl_box_that_needs_shaping_stays_right_aligned_when_moved():
    """Such a box is stored without lines, so its next move arrives with none —
    the right alignment the editor shows must come from the text itself."""
    lines = ["שָׁלוֹם עוֹלָם", "דִּירָה"]
    spec = _text_box("tb", 72, 100, lines, 14)
    spec["rect"]["w"] = 0.4
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    [item] = A.extract_annotations(out)
    moved = {**item, "rect": {**item["rect"], "x": 0.3}}
    moved.pop("lines", None)
    out, _ = A.apply_annotation_ops(out, ops=[{"action": "update", "annotation": moved}])
    right = (0.3 + 0.4) * 595
    spans = [s for s in _spans(out) if s["text"].strip()]
    assert spans and max(s["bbox"][2] for s in spans) == pytest.approx(right, abs=1.5)
    # every line flush right, the short one included
    for line in ({round(s["bbox"][1]) for s in spans}):
        assert max(s["bbox"][2] for s in spans if round(s["bbox"][1]) == line) \
            == pytest.approx(right, abs=1.5)


def test_lines_with_only_latin_1_characters_round_trip():
    """A string with nothing above U+00FF was written as PDFDocEncoding bytes,
    and a no-break space or a soft hyphen came back as something else — so the
    freshness check dropped the client's own lines."""
    lines = ["Total\u00a0: 12,50 EUR", "Merci de payer avant le 30", "co\u00adoperation"]
    spec = _text_box("tb", 72, 100, lines, 12)
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(spec))
    [item] = A.extract_annotations(out)
    assert item["lines"] == lines


def test_decomposed_accents_are_drawn_composed():
    """"e" + U+0301 is "é" to the browser, which composes it; the file draws
    the composed letter, which Arimo has — and keeps the lines as sent."""
    lines = ["Zoë café"]
    out, _ = A.apply_annotation_ops(_blank(), ops=_add(_text_box("tb", 72, 100, lines, 12)))
    [span] = [s for s in _spans(out) if s["text"].strip()]
    assert span["text"] == "Zoë café"
    assert span["font"].startswith("Arimo")
    [item] = A.extract_annotations(out)
    assert item["lines"] == lines


def test_several_boxes_in_one_batch_each_draw_their_own_lines():
    ops = []
    for i in range(6):
        ops += _add(_text_box(f"tb{i}", 72, 80 + 60 * i, [f"Box {i}", f"line two of {i}"], 12))
    out, report = A.apply_annotation_ops(_blank(), ops=ops)
    assert report["added"] == 6
    texts = [s["text"] for s in _spans(out) if s["text"].strip()]
    assert sorted(texts) == sorted(t for i in range(6) for t in (f"Box {i}", f"line two of {i}"))
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert doc.page_count == 1  # every scratch page is gone
    finally:
        doc.close()


def test_a_long_pasted_list_is_within_the_schema():
    """`lines` is bounded by what `contents` can lay out into. A 200-line cap
    rejected a pasted list — and every other mark in that save with it."""
    from apps.pdf_engine.registry import validate_params

    lines = [f"item {i}" for i in range(300)]
    spec = _text_box("tb", 72, 100, lines[:1], 6)
    spec["lines"], spec["contents"] = lines, "\n".join(lines)
    validate_params("annotate_batch", {"ops": _add(spec)})
