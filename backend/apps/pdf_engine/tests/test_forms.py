"""Golden tests for the forms engine (phase-05; §8, §10, §18)."""
import fitz
import pytest

from apps.pdf_engine.engine import forms as F
from apps.pdf_engine.exceptions import (
    DocumentEncryptedError,
    InvalidParams,
    PageOutOfRange,
)


def _widgets(data: bytes) -> list[tuple[str, str, str]]:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return [(w.field_name, w.field_type_string, str(w.field_value))
                for page in doc for w in page.widgets()]
    finally:
        doc.close()


def _values(data: bytes) -> dict:
    return {f["name"]: f["value"] for f in F.read_form(data)["fields"]}


def _blank(pages: int = 1) -> bytes:
    doc = fitz.open()
    for _ in range(pages):
        doc.new_page(width=595, height=842)
    try:
        return doc.tobytes()
    finally:
        doc.close()


def _rect(y: float = 0.1) -> dict:
    return {"x": 0.1, "y": y, "w": 0.4, "h": 0.03}


# --------------------------------------------------------------------------- #
# Read model
# --------------------------------------------------------------------------- #
def test_read_form_reports_the_fixture_fields(fixture_bytes):
    model = F.read_form(fixture_bytes("form.pdf"))
    assert model["has_form"] is True
    assert model["is_xfa"] is False
    names = {f["name"]: f for f in model["fields"]}
    assert names["full_name"]["type"] == "text"
    assert names["agree"]["type"] == "checkbox"
    assert 0 <= names["full_name"]["rect"]["x"] <= 1


def test_the_multi_type_fixture_reads_as_four_distinct_types(fixture_bytes):
    """`form-multi.pdf` is what the browser fill path is driven against, so the
    engine has to agree with PDF.js about what each field is."""
    model = F.read_form(fixture_bytes("form-multi.pdf"))
    kinds = {f["name"]: f["type"] for f in model["fields"]}
    assert kinds == {"attendee": "text", "vegetarian": "checkbox",
                     "ticket": "combobox", "track": "listbox"}
    options = {f["name"]: f["options"] for f in model["fields"]}
    assert options["ticket"] == ["standard", "student", "speaker"]

    filled, report = F.fill_form(fixture_bytes("form-multi.pdf"), values={
        "attendee": "Ada", "vegetarian": True, "ticket": "speaker",
        "track": "frontend",
    })
    assert report["filled"] == 4
    assert _values(filled) == {"attendee": "Ada", "vegetarian": "Yes",
                               "ticket": "speaker", "track": "frontend"}


def test_the_read_model_carries_the_reset_value(fixture_bytes):
    """`default` is `/DV` — what the field goes back to on "Reset form", and a
    separate thing from `/V`. PyMuPDF's Widget exposes only the latter."""
    doc = fitz.open(stream=fixture_bytes("form.pdf"), filetype="pdf")
    try:
        widget = next(w for w in doc[0].widgets() if w.field_name == "full_name")
        doc.xref_set_key(widget.xref, "DV", fitz.get_pdf_str("Your name here"))
        data = doc.tobytes()
    finally:
        doc.close()

    field = next(f for f in F.read_form(data)["fields"] if f["name"] == "full_name")
    assert field["default"] == "Your name here"
    assert field["value"] == ""  # untouched by a default


def test_a_document_without_a_form_says_so(fixture_bytes):
    model = F.read_form(fixture_bytes("text.pdf"))
    assert model["has_form"] is False
    assert model["fields"] == []


def test_xfa_is_detected(fixture_bytes):
    """The acceptance criterion's "degrades gracefully": the fallback AcroForm
    fields are still reported, *and* the caller is told it is XFA."""
    model = F.read_form(fixture_bytes("xfa-form.pdf"))
    assert model["is_xfa"] is True
    assert model["has_form"] is True
    assert [f["name"] for f in model["fields"]] == ["legacy_name"]


def test_reading_an_xfa_form_does_not_crash(fixture_bytes):
    data = fixture_bytes("xfa-form.pdf")
    out, _ = F.fill_form(data, values={"legacy_name": "Ada"})
    assert _values(out)["legacy_name"] == "Ada"


# --------------------------------------------------------------------------- #
# Filling
# --------------------------------------------------------------------------- #
def test_fill_every_field_type_and_read_it_back(fixture_bytes):
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                    "rect": _rect(0.10)}},
        {"action": "add", "field": {"name": "agree", "type": "checkbox", "page": 0,
                                    "rect": _rect(0.20)}},
        {"action": "add", "field": {"name": "size", "type": "combobox", "page": 0,
                                    "rect": _rect(0.30),
                                    "options": ["small", "medium", "large"]}},
        {"action": "add", "field": {"name": "colour", "type": "listbox", "page": 0,
                                    "rect": _rect(0.40), "options": ["red", "blue"]}},
    ])
    out, report = F.fill_form(built, values={
        "who": "Ada Lovelace", "agree": True, "size": "large", "colour": "blue",
    })
    assert report["filled"] == 4
    values = _values(out)
    assert values["who"] == "Ada Lovelace"
    assert values["agree"] in {"Yes", "On"}
    assert values["size"] == "large"
    assert values["colour"] == "blue"


def test_checkbox_accepts_the_shapes_a_form_import_produces(fixture_bytes):
    for raw, expected_on in (("true", True), ("yes", True), ("on", True),
                             ("1", True), ("false", False), ("", False)):
        out, _ = F.fill_form(fixture_bytes("form.pdf"), values={"agree": raw})
        got = _values(out)["agree"]
        assert bool(got) == expected_on, f"{raw!r} -> {got!r}"


def test_an_unknown_field_name_is_named_in_the_error(fixture_bytes):
    with pytest.raises(InvalidParams) as exc:
        F.fill_form(fixture_bytes("form.pdf"), values={"nope": "x", "also_nope": "y"})
    assert "nope" in str(exc.value)
    assert "also_nope" in str(exc.value)


def test_a_choice_value_outside_the_options_is_refused():
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "size", "type": "combobox", "page": 0,
                                    "rect": _rect(), "options": ["s", "m"]}},
    ])
    with pytest.raises(InvalidParams) as exc:
        F.fill_form(built, values={"size": "xxl"})
    assert "xxl" in str(exc.value)


def test_fill_then_flatten_leaves_the_values_as_page_content(fixture_bytes):
    out, report = F.fill_form(fixture_bytes("form.pdf"),
                              values={"full_name": "Grace Hopper"},
                              flatten_after=True)
    assert report["flattened"] is True
    assert _widgets(out) == [], "the widgets must be gone"
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert "Grace Hopper" in doc[0].get_text()
    finally:
        doc.close()


def _ink_in(data: bytes, rect: dict, zoom: float) -> int:
    """Non-white pixels inside a normalized rect, rendered at `zoom`."""
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        page = doc[0]
        w, h = page.rect.width, page.rect.height
        clip = fitz.Rect(rect["x"] * w, rect["y"] * h,
                         (rect["x"] + rect["w"]) * w, (rect["y"] + rect["h"]) * h)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip)
        samples, stride = pix.samples, pix.n
        return sum(1 for i in range(0, len(samples), stride)
                   if samples[i] < 200 or samples[i + 1] < 200 or samples[i + 2] < 200)
    finally:
        doc.close()


@pytest.mark.parametrize("zoom", [1.0, 2.0])
def test_a_filled_value_is_actually_drawn_in_the_widget(fixture_bytes, zoom):
    """phase-05 §Risks: "widget appearance streams (fonts in filled text) →
    PyMuPDF regenerates appearances on `update()`; golden pixel checks on two
    zoom levels". Value present in `/V` is not the same as value *visible*: a
    field whose appearance stream was not regenerated reads back correctly and
    renders empty in every viewer."""
    blank = fixture_bytes("form.pdf")
    rect = next(f for f in F.read_form(blank)["fields"]
                if f["name"] == "full_name")["rect"]
    before = _ink_in(blank, rect, zoom)

    filled, _ = F.fill_form(blank, values={"full_name": "Grace Hopper"})
    after = _ink_in(filled, rect, zoom)
    assert after > before + 50, f"nothing was drawn into the field at {zoom}×"

    # And it survives flattening — the appearance stream *is* what gets baked.
    flat, _ = F.fill_form(blank, values={"full_name": "Grace Hopper"},
                          flatten_after=True)
    assert _ink_in(flat, rect, zoom) > before + 50


def test_a_value_in_a_field_the_builder_made_is_drawn_and_survives_flattening():
    """The other half of phase-05's "create fields → fill → flatten → text
    present, widgets gone": a *built* field's appearance stream is generated by
    us, so it is the one most likely to bake empty."""
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                    "rect": _rect(0.2)}},
    ])
    rect = F.read_form(built)["fields"][0]["rect"]
    before = _ink_in(built, rect, 2.0)

    filled, _ = F.fill_form(built, values={"who": "Ada Lovelace"},
                            flatten_after=True)
    assert _widgets(filled) == [], "the widgets must be gone"
    assert _ink_in(filled, rect, 2.0) > before + 50, "the value baked away"

    doc = fitz.open(stream=filled, filetype="pdf")
    try:
        assert "Ada Lovelace" in doc[0].get_text()
    finally:
        doc.close()


def test_fill_form_needs_values(fixture_bytes):
    with pytest.raises(InvalidParams):
        F.fill_form(fixture_bytes("form.pdf"), values={})


# --------------------------------------------------------------------------- #
# Field creation — the six types
# --------------------------------------------------------------------------- #
def test_build_a_form_from_a_blank_pdf_with_all_six_types():
    """The acceptance criterion, end to end: six types placed, named, filled,
    exported and flattened."""
    ops = [
        {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                    "rect": _rect(0.10), "required": True}},
        {"action": "add", "field": {"name": "agree", "type": "checkbox", "page": 0,
                                    "rect": _rect(0.20)}},
        {"action": "add", "field": {"name": "plan", "type": "radio", "page": 0,
                                    "options": ["basic", "pro"],
                                    "rects": [_rect(0.30), _rect(0.35)]}},
        {"action": "add", "field": {"name": "size", "type": "combobox", "page": 0,
                                    "rect": _rect(0.45), "options": ["s", "m", "l"]}},
        {"action": "add", "field": {"name": "colour", "type": "listbox", "page": 0,
                                    "rect": _rect(0.55), "options": ["red", "blue"]}},
        {"action": "add", "field": {"name": "sign_here", "type": "signature", "page": 0,
                                    "rect": {"x": 0.1, "y": 0.7, "w": 0.35, "h": 0.06}}},
    ]
    built, report = F.edit_fields_batch(_blank(), ops=ops)
    assert report["added"] == 6

    model = F.read_form(built)
    by_name = {f["name"]: f for f in model["fields"]}
    assert set(by_name) == {"who", "agree", "plan", "size", "colour", "sign_here"}
    assert by_name["who"]["flags"]["required"] is True
    assert by_name["plan"]["type"] == "radio"
    assert sorted(by_name["plan"]["options"]) == ["basic", "pro"]
    assert by_name["sign_here"]["type"] == "signature"

    filled, _ = F.fill_form(built, values={
        "who": "Ada", "agree": True, "plan": "pro", "size": "m", "colour": "red",
    })
    values = _values(filled)
    assert values["who"] == "Ada"
    assert values["plan"] == "pro"

    payload, filename, content_type = F.export_form_data(filled, fmt="json")
    assert filename.endswith(".json") and content_type == "application/json"
    import json

    assert json.loads(payload)["plan"] == "pro"

    from apps.pdf_engine.engine.annotations import flatten_annotations

    flat = flatten_annotations(filled, what="form")
    assert _widgets(flat) == []


def test_alignment_is_written_onto_the_field():
    """`align` is `/Q` in the field dict — the property panel offers it, and
    PyMuPDF's Widget has no attribute that carries it."""
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "centred", "type": "text", "page": 0,
                                    "rect": _rect(0.1), "align": "center"}},
        {"action": "add", "field": {"name": "plain", "type": "text", "page": 0,
                                    "rect": _rect(0.2)}},
    ])
    doc = fitz.open(stream=built, filetype="pdf")
    try:
        quadding = {w.field_name: doc.xref_get_key(w.xref, "Q")
                    for w in doc[0].widgets()}
    finally:
        doc.close()
    assert quadding["centred"] == ("int", "1")
    assert quadding["plain"][0] == "null"


def test_a_signature_field_is_a_real_sig_field():
    """Routed through pyHanko, so phase 8 can sign into it."""
    import io as _io

    import pikepdf

    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "Signature1", "type": "signature",
                                    "page": 0, "rect": {"x": 0.1, "y": 0.7,
                                                        "w": 0.35, "h": 0.06}}},
    ])
    pdf = pikepdf.open(_io.BytesIO(built))
    try:
        names = {str(f.get("/T")): str(f.get("/FT"))
                 for f in pdf.Root.AcroForm.Fields}
    finally:
        pdf.close()
    assert names.get("Signature1") == "/Sig"


def test_a_signature_field_lands_where_it_was_placed():
    """pyHanko boxes are PDF-native (origin bottom-left); everything else in
    the engine is §8 top-left. Getting the flip wrong puts the signature
    placeholder at the other end of the page, which nothing else would catch."""
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "sig", "type": "signature", "page": 0,
                                    "rect": {"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.05}}},
    ])
    field = next(f for f in F.read_form(built)["fields"] if f["name"] == "sig")
    assert field["rect"]["x"] == pytest.approx(0.1, abs=0.01)
    assert field["rect"]["y"] == pytest.approx(0.1, abs=0.01)
    assert field["rect"]["w"] == pytest.approx(0.3, abs=0.01)
    assert field["rect"]["h"] == pytest.approx(0.05, abs=0.01)


def _radio_state(data: bytes, name: str) -> tuple[str, list[str]]:
    """(parent `/V`, each kid's `/AS`) — where a radio group's answer lives.

    Asserted here rather than through `widget.field_value`, which reports the
    *inherited* parent value for every kid once the group is structured the way
    the spec wants: the answer belongs to the parent field, and it is `/AS`
    that decides which kid renders as filled in.
    """
    import io as _io

    import pikepdf

    pdf = pikepdf.open(_io.BytesIO(data))
    try:
        field = next(f for f in pdf.Root.AcroForm.Fields if str(f.get("/T", "")) == name)
        kids = list(field.get("/Kids") or [])
        return str(field.get("/V", "")), [str(k.get("/AS", "")) for k in kids]
    finally:
        pdf.close()


def test_radio_options_are_mutually_exclusive():
    """The property that makes a radio group a radio group: selecting one
    option clears the others. Each kid carries its own export value — PyMuPDF's
    own radio widget gives them all the same one."""
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "plan", "type": "radio", "page": 0,
                                    "options": ["basic", "pro", "team"],
                                    "rects": [_rect(0.10), _rect(0.20), _rect(0.30)]}},
    ])
    filled, _ = F.fill_form(built, values={"plan": "pro"})
    value, states = _radio_state(filled, "plan")
    assert value == "/pro"
    assert states == ["/Off", "/pro", "/Off"], f"exactly one may be on, got {states}"
    assert _values(filled)["plan"] == "pro"

    again, _ = F.fill_form(filled, values={"plan": "team"})
    value, states = _radio_state(again, "plan")
    assert value == "/team"
    assert states == ["/Off", "/Off", "/team"], "switching must clear the previous one"
    assert _values(again)["plan"] == "team"


@pytest.mark.parametrize("options", [
    ["Option 1", "Option 2"],          # the builder's own default text
    ["a/b", "a#b"],                    # characters PDF names escape
    ["Ja", "Nein-ü"],                  # non-ASCII
])
def test_a_radio_option_survives_being_a_pdf_name(options):
    """An option is stored as a PDF *name*, so pikepdf escapes anything not
    name-safe and PyMuPDF hands the raw token back. Without decoding, the read
    model advertised `Option#201`, neither spelling selected anything, and each
    builder round trip escaped the escape (`Option#23201`, `Option#2323201`)."""
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "plan", "type": "radio", "page": 0,
                                    "options": options,
                                    "rects": [_rect(0.2), _rect(0.3)]}},
    ])
    field = F.read_form(built)["fields"][0]
    assert field["options"] == options

    chosen, _ = F.fill_form(built, values={"plan": options[1]})
    assert _values(chosen)["plan"] == options[1]

    # And the labels are stable across a builder edit — re-adding from what the
    # read model reported must not escape them a second time.
    again, _ = F.edit_fields_batch(built, ops=[
        {"action": "update", "field": {"name": "plan", "type": "radio", "page": 0,
                                       "options": field["options"],
                                       "rects": [_rect(0.4), _rect(0.5)]}},
    ])
    assert F.read_form(again)["fields"][0]["options"] == options


def test_a_field_placed_on_two_pages_is_one_text_field_not_a_radio_group():
    """The commonest AcroForm shape there is: one name/date field repeated on
    every page. Calling a second same-named widget "a radio option" left it
    with no options, and the "nothing selected" cleanup then erased its value —
    so export blanked it and the UI rendered a choice list with no choices."""
    doc = fitz.open()
    for _ in range(2):
        page = doc.new_page(width=595, height=842)
        widget = fitz.Widget()
        widget.field_name = "signer_name"
        widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        widget.rect = fitz.Rect(72, 120, 400, 145)
        widget.field_value = "Ada Lovelace"
        page.add_widget(widget)
    data = doc.tobytes()
    doc.close()

    field = F.read_form(data)["fields"][0]
    assert field["type"] == "text"
    assert field["value"] == "Ada Lovelace"
    assert len(field["widgets"]) == 2, "both placements are reported"

    payload, _, _ = F.export_form_data(data, fmt="json")
    import json as _json

    assert _json.loads(payload) == {"signer_name": "Ada Lovelace"}


def test_a_radio_group_leaves_one_field_in_the_acroform():
    """The kids must not stay registered as top-level fields as well, and a
    deleted group must not leave a parent behind whose /Kids dangle — both are
    invisible to us and visible to Acrobat and to pyHanko in Phase 8."""
    import io as _io

    import pikepdf

    def titles(data: bytes) -> list[str]:
        pdf = pikepdf.open(_io.BytesIO(data))
        try:
            return [str(f.get("/T", "")) for f in pdf.Root.AcroForm.Fields]
        finally:
            pdf.close()

    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "plan", "type": "radio", "page": 0,
                                    "options": ["basic", "pro"],
                                    "rects": [_rect(0.2), _rect(0.3)]}},
    ])
    assert titles(built) == ["plan"]

    # Update is delete-then-add; the name must not end up in the file twice.
    updated, _ = F.edit_fields_batch(built, ops=[
        {"action": "update", "field": {"name": "plan", "type": "radio", "page": 0,
                                       "options": ["basic", "pro", "team"],
                                       "rects": [_rect(0.2), _rect(0.3), _rect(0.4)]}},
    ])
    assert titles(updated) == ["plan"]

    removed, _ = F.edit_fields_batch(updated, ops=[
        {"action": "delete", "field": {"name": "plan"}},
    ])
    assert titles(removed) == []
    assert F.read_form(removed)["has_form"] is False


def test_a_signature_field_is_not_filled_in_by_an_import_round_trip():
    """`export → import` used to write `/V ()` onto the `/Sig` field, after
    which pyHanko refuses it ("appears to be filled already") — bricking the
    placeholder Phase 8 exists to sign into."""
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                    "rect": _rect(0.2)}},
        {"action": "add", "field": {"name": "sign_here", "type": "signature",
                                    "page": 0, "rect": _rect(0.5)}},
    ])
    payload, _, _ = F.export_form_data(built, fmt="json")
    import json as _json

    assert "sign_here" not in _json.loads(payload), "a signature has no value to export"

    back, _ = F.fill_form(built, values=F.parse_form_data(payload, fmt="json") or {"who": ""})
    doc = fitz.open(stream=back, filetype="pdf")
    try:
        sig = next(w for w in doc[0].widgets() if w.field_name == "sign_here")
        assert doc.xref_get_key(sig.xref, "V")[0] == "null", "empty /V was written"
    finally:
        doc.close()

    # Filling one deliberately is an error the user can act on, not a silent no-op.
    with pytest.raises(InvalidParams, match="signed, not filled"):
        F.fill_form(built, values={"sign_here": "Ada"})


def test_export_csv_defuses_a_spreadsheet_formula():
    """CWE-1236: the values come out of a PDF somebody else wrote, and Export
    CSV is one click away from a victim opening it in Excel."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    widget = fitz.Widget()
    widget.field_name = "notes"
    widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    widget.rect = fitz.Rect(72, 120, 400, 145)
    widget.field_value = "=cmd|' /C calc'!A0"
    page.add_widget(widget)
    data = doc.tobytes()
    doc.close()

    payload, _, _ = F.export_form_data(data, fmt="csv")
    line = payload.decode().splitlines()[1]
    assert line.startswith("notes,")
    assert "'=cmd" in line, "the formula was not neutralised"
    # JSON is not a spreadsheet — it must not be mangled.
    import json as _json

    assert _json.loads(F.export_form_data(data, fmt="json")[0])["notes"].startswith("=cmd")


def test_deeply_nested_json_is_a_validation_error_not_a_stack_overflow():
    with pytest.raises(InvalidParams):
        F.parse_form_data(b"[" * 200000 + b"]" * 200000, fmt="json")


def test_an_unknown_name_error_does_not_echo_the_whole_payload(fixture_bytes):
    """The message is stored on the Job row and echoed on every poll; an import
    of 90 000 unknown names produced 900 KB of error."""
    with pytest.raises(InvalidParams) as exc:
        F.fill_form(fixture_bytes("form.pdf"),
                    values={f"unknown_{i}": "x" for i in range(500)})
    assert len(str(exc.value)) < 2000
    assert "more" in str(exc.value)


def test_a_signature_field_lands_where_it_was_placed_on_a_rotated_offset_page():
    """`~transformation_matrix` carries the page origin only when rotation is 0;
    on a rotated page PyMuPDF computes it against a zero-origin box, so the
    signature landed a whole MediaBox origin away — off the page, where
    clamping then hid it."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.set_mediabox(fitz.Rect(100, 200, 695, 1042))
    doc[0].set_rotation(90)
    data = doc.tobytes()
    doc.close()

    built, _ = F.edit_fields_batch(data, ops=[
        {"action": "add", "field": {"name": "sig", "type": "signature", "page": 0,
                                    "rect": {"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.05}}},
    ])
    got = next(f for f in F.read_form(built)["fields"] if f["name"] == "sig")["rect"]
    assert got["x"] == pytest.approx(0.1, abs=0.02)
    assert got["y"] == pytest.approx(0.1, abs=0.02)
    assert got["w"] == pytest.approx(0.3, abs=0.02)


def test_a_built_field_keeps_its_properties_when_it_is_moved():
    """An update is delete-then-add from the spec the client sends, so anything
    the read model does not report is reset the first time a field is dragged."""
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                    "rect": _rect(0.2), "max_len": 12,
                                    "align": "center", "font_size": 18,
                                    "default": "seed"}},
    ])
    field = F.read_form(built)["fields"][0]
    assert field["max_len"] == 12
    assert field["align"] == "center"
    assert field["font_size"] == pytest.approx(18)
    assert field["default"] == "seed"

    # Re-send exactly what the read model reported, as the builder does.
    moved, _ = F.edit_fields_batch(built, ops=[
        {"action": "update", "field": {"name": "who", "type": "text", "page": 0,
                                       "rect": _rect(0.6),
                                       "max_len": field["max_len"],
                                       "align": field["align"],
                                       "font_size": field["font_size"],
                                       "default": field["default"]}},
    ])
    after = F.read_form(moved)["fields"][0]
    assert after["max_len"] == 12
    assert after["align"] == "center"
    assert after["font_size"] == pytest.approx(18)
    assert after["default"] == "seed"


def test_a_radio_group_needs_a_rect_per_option():
    with pytest.raises(InvalidParams) as exc:
        F.edit_fields_batch(_blank(), ops=[
            {"action": "add", "field": {"name": "plan", "type": "radio", "page": 0,
                                        "options": ["a", "b", "c"],
                                        "rects": [_rect(0.1)]}},
        ])
    assert "rect per option" in str(exc.value)


def test_duplicate_field_names_are_refused():
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                    "rect": _rect()}},
    ])
    with pytest.raises(InvalidParams) as exc:
        F.edit_fields_batch(built, ops=[
            {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                        "rect": _rect(0.5)}},
        ])
    assert "unique" in str(exc.value)


def test_update_replaces_a_field_including_its_type():
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "answer", "type": "text", "page": 0,
                                    "rect": _rect()}},
    ])
    updated, report = F.edit_fields_batch(built, ops=[
        {"action": "update", "field": {"name": "answer", "type": "combobox",
                                       "page": 0, "rect": _rect(),
                                       "options": ["yes", "no"]}},
    ])
    assert report["updated"] == 1
    field = F.read_form(updated)["fields"][0]
    assert field["type"] == "combobox"
    assert field["options"] == ["yes", "no"]


def test_delete_removes_the_field():
    built, _ = F.edit_fields_batch(_blank(), ops=[
        {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                    "rect": _rect()}},
        {"action": "add", "field": {"name": "why", "type": "text", "page": 0,
                                    "rect": _rect(0.3)}},
    ])
    out, report = F.edit_fields_batch(built, ops=[
        {"action": "delete", "field": {"name": "who"}},
    ])
    assert report["deleted"] == 1
    assert [f["name"] for f in F.read_form(out)["fields"]] == ["why"]


def test_deleting_a_field_that_is_not_there_is_named():
    with pytest.raises(InvalidParams) as exc:
        F.edit_fields_batch(_blank(), ops=[
            {"action": "delete", "field": {"name": "ghost"}},
        ])
    assert "ghost" in str(exc.value)


def test_fields_can_be_placed_on_any_page():
    built, _ = F.edit_fields_batch(_blank(3), ops=[
        {"action": "add", "field": {"name": "first", "type": "text", "page": 0,
                                    "rect": _rect()}},
        {"action": "add", "field": {"name": "last", "type": "text", "page": 2,
                                    "rect": _rect()}},
    ])
    pages = {f["name"]: f["page"] for f in F.read_form(built)["fields"]}
    assert pages == {"first": 0, "last": 2}


def test_a_field_off_the_end_of_the_document_is_refused():
    with pytest.raises(PageOutOfRange):
        F.edit_fields_batch(_blank(), ops=[
            {"action": "add", "field": {"name": "x", "type": "text", "page": 9,
                                        "rect": _rect()}},
        ])


def test_a_field_on_a_rotated_page_lands_where_it_was_placed(fixture_bytes):
    """Widgets are annotations, so they are written in the page's unrotated
    space (§8) — the same trap as phase 3."""
    built, _ = F.edit_fields_batch(fixture_bytes("rotated-90.pdf"), ops=[
        {"action": "add", "field": {"name": "who", "type": "text", "page": 0,
                                    "rect": {"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.05}}},
    ])
    field = F.read_form(built)["fields"][0]
    assert field["rect"]["x"] == pytest.approx(0.1, abs=0.02)
    assert field["rect"]["y"] == pytest.approx(0.1, abs=0.02)


# --------------------------------------------------------------------------- #
# Import / export
# --------------------------------------------------------------------------- #
def test_json_round_trip_is_identical(fixture_bytes):
    """Acceptance: export JSON → clear → import → identical values."""
    filled, _ = F.fill_form(fixture_bytes("form.pdf"),
                            values={"full_name": "Ada Lovelace", "agree": True})
    before = _values(filled)

    payload, _, _ = F.export_form_data(filled, fmt="json")
    cleared, _ = F.fill_form(filled, values={"full_name": "", "agree": False})
    assert _values(cleared)["full_name"] == ""

    restored, _ = F.fill_form(cleared, values=F.parse_form_data(payload, fmt="json"))
    assert _values(restored) == before


def test_csv_round_trip(fixture_bytes):
    filled, _ = F.fill_form(fixture_bytes("form.pdf"), values={"full_name": "Grace"})
    payload, filename, content_type = F.export_form_data(filled, fmt="csv")
    assert filename.endswith(".csv") and content_type == "text/csv"
    assert F.parse_form_data(payload, fmt="csv")["full_name"] == "Grace"


def test_csv_wide_form_is_accepted():
    """A header row of names plus one row of values — what a spreadsheet
    produces if you lay a form out horizontally."""
    values = F.parse_form_data(b"full_name,agree\nAda,Yes\n", fmt="csv")
    assert values == {"full_name": "Ada", "agree": "Yes"}


def test_csv_with_only_headers_says_what_it_expected():
    with pytest.raises(InvalidParams) as exc:
        F.parse_form_data(b"full_name,agree\n", fmt="csv")
    assert "name,value" in str(exc.value)


def test_import_rejects_broken_json():
    with pytest.raises(InvalidParams):
        F.parse_form_data(b"{not json", fmt="json")


def test_import_rejects_a_json_array():
    with pytest.raises(InvalidParams) as exc:
        F.parse_form_data(b'["a", "b"]', fmt="json")
    assert "object" in str(exc.value)


def test_export_rejects_an_unknown_format(fixture_bytes):
    with pytest.raises(InvalidParams):
        F.export_form_data(fixture_bytes("form.pdf"), fmt="xml")


def test_a_bom_prefixed_export_still_imports():
    """Excel writes a UTF-8 BOM; without `utf-8-sig` the first field name comes
    back with an invisible character glued to it and never matches."""
    values = F.parse_form_data("﻿name,value\nfull_name,Ada\n".encode(), fmt="csv")
    assert values == {"full_name": "Ada"}


# --------------------------------------------------------------------------- #
# Guardrails
# --------------------------------------------------------------------------- #
def test_encrypted_documents_are_refused(fixture_bytes):
    with pytest.raises(DocumentEncryptedError):
        F.read_form(fixture_bytes("encrypted.pdf"))
    with pytest.raises(DocumentEncryptedError):
        F.fill_form(fixture_bytes("encrypted.pdf"), values={"a": "b"})


def test_unknown_field_type_is_refused():
    with pytest.raises(InvalidParams):
        F.edit_fields_batch(_blank(), ops=[
            {"action": "add", "field": {"name": "x", "type": "slider", "page": 0,
                                        "rect": _rect()}},
        ])


def test_unknown_action_is_refused():
    with pytest.raises(InvalidParams):
        F.edit_fields_batch(_blank(), ops=[
            {"action": "mangle", "field": {"name": "x"}},
        ])


def test_empty_ops_is_refused():
    with pytest.raises(InvalidParams):
        F.edit_fields_batch(_blank(), ops=[])


def test_a_choice_field_needs_options():
    with pytest.raises(InvalidParams):
        F.edit_fields_batch(_blank(), ops=[
            {"action": "add", "field": {"name": "x", "type": "combobox", "page": 0,
                                        "rect": _rect()}},
        ])
