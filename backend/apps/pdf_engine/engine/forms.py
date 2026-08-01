"""Forms engine (phase-05; 01-architecture.md §8, §10).

Fill existing AcroForms, create and edit fields, import/export data. XFA and
field-level JavaScript are out of scope (02-feature-matrix) — an XFA document is
*detected* and the UI warns, rather than being silently half-rendered.

Two things here are not PyMuPDF-shaped and are done at the PDF level instead:

* **Radio groups.** PyMuPDF's `RADIOBUTTON` widget raises "bad xref" on the
  first `add_widget` and "bad rect" on `update()`, and gives every kid the same
  `Yes` on-state — so the options cannot be told apart. A radio group is
  properly one parent field with N kid widgets, each with its own export value,
  so that is what `_build_radio_group` writes.
* **Signature fields.** Routed through pyHanko's `append_signature_field`
  (phase-05). PyMuPDF *can* emit a `/Sig` field, but pyHanko is the library that
  will later consume it (phase 8) and `SigFieldSpec` is where seed values and
  lock dictionaries live, which the Widget API cannot express.
"""
from __future__ import annotations

import csv
import io
import json

import fitz

from ..exceptions import InvalidParams, PageOutOfRange, UnsupportedFileError
from ..geometry import (
    NormRect,
    apply_matrix_rect,
    norm_to_page_rect,
    page_rect_to_norm_clamped,
    page_rect_to_pdf_native,
)

_SAVE = dict(garbage=4, deflate=True, deflate_images=True, deflate_fonts=True)

FIELD_TYPES = ("text", "checkbox", "radio", "combobox", "listbox", "signature")

_WIDGET_TO_TYPE = {
    fitz.PDF_WIDGET_TYPE_TEXT: "text",
    fitz.PDF_WIDGET_TYPE_CHECKBOX: "checkbox",
    fitz.PDF_WIDGET_TYPE_RADIOBUTTON: "radio",
    fitz.PDF_WIDGET_TYPE_COMBOBOX: "combobox",
    fitz.PDF_WIDGET_TYPE_LISTBOX: "listbox",
    fitz.PDF_WIDGET_TYPE_SIGNATURE: "signature",
}

# AcroForm field flags (PDF 32000-1 table 227/228).
FF_READONLY = 1 << 0
FF_REQUIRED = 1 << 1
FF_MULTILINE = 1 << 12
FF_PASSWORD = 1 << 13
FF_RADIO = 1 << 15

# Separator for a radio kid's temporary name while the group is assembled.
# Printable on purpose — see `_build_radio_group`.
_RADIO_SEP = "\u2400zenradio\u2400"

# `/Q` quadding — how the value sits in the box.
_ALIGN = {"left": 0, "center": 1, "right": 2}


def _open(data: bytes) -> fitz.Document:
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise UnsupportedFileError(f"Could not open PDF: {exc}") from exc
    if doc.needs_pass:
        doc.close()
        from ..exceptions import DocumentEncryptedError

        raise DocumentEncryptedError("Document is encrypted; unlock before editing.")
    return doc


def _page(doc: fitz.Document, index) -> fitz.Page:
    try:
        i = int(index)
    except (TypeError, ValueError) as exc:
        raise InvalidParams(f"invalid page {index!r}") from exc
    if i < 0 or i >= doc.page_count:
        raise PageOutOfRange(f"page {i} out of range (0..{doc.page_count - 1})")
    return doc[i]


def is_xfa(doc: fitz.Document) -> bool:
    """True for an XFA form.

    XFA describes the form in an XML payload that PDF readers other than Acrobat
    largely ignore; the AcroForm fields alongside it are often a partial
    fallback. Detecting it is the difference between a warning and a user
    silently filling in a form that will not carry their answers.

    The **path** lookup matters: `/AcroForm` is an inline dictionary in some
    files and an indirect reference in others, and resolving it by hand only
    handles the second, so half of all XFA documents went undetected.
    """
    return doc.xref_get_key(doc.pdf_catalog(), "AcroForm/XFA")[0] != "null"


def _flags_of(widget) -> int:
    try:
        return int(widget.field_flags or 0)
    except (TypeError, ValueError):
        return 0


def _on_states(widget) -> list[str]:
    states = widget.button_states() or {}
    normal = states.get("normal") or []
    return [s.lstrip("/") for s in normal if s and s.lstrip("/") != "Off"]


def _default_of(doc: fitz.Document, widget) -> str:
    """`/DV` — what "Reset form" would put back. PyMuPDF exposes `/V` only.

    Looked up on the widget and then on its parent, because a radio kid keeps
    the value on the parent field.
    """
    for path in ("DV", "Parent/DV"):
        kind, raw = doc.xref_get_key(widget.xref, path)
        if kind == "string":
            return str(raw).strip()
        if kind == "name":
            state = str(raw).lstrip("/")
            return "" if state == "Off" else state
    return ""


def _align_of(doc: fitz.Document, widget) -> str:
    """`/Q` back out again — the property panel prefills from this.

    Without it the panel showed "Left" for every saved field, and applying any
    other property then wrote left-alignment over a centred one.
    """
    for path in ("Q", "Parent/Q"):
        kind, raw = doc.xref_get_key(widget.xref, path)
        if kind == "int":
            for name, code in _ALIGN.items():
                if code == int(raw):
                    return name
    return "left"


def read_form(data: bytes) -> dict:
    """The form read model (phase-05 §"Read model")."""
    doc = _open(data)
    try:
        xfa = is_xfa(doc)
        by_name: dict[str, dict] = {}
        order: list[str] = []
        for index in range(doc.page_count):
            page = doc[index]
            pw, ph = page.rect.width, page.rect.height
            rot = tuple(page.rotation_matrix)
            for widget in page.widgets():
                name = widget.field_name or ""
                if not name:
                    continue
                kind = _WIDGET_TO_TYPE.get(widget.field_type, "text")
                flags = _flags_of(widget)
                rect = widget.rect
                x0, y0, x1, y1 = apply_matrix_rect(rect.x0, rect.y0, rect.x1, rect.y1, rot)
                nr = page_rect_to_norm_clamped(x0, y0, x1, y1, pw, ph)
                on_states = _on_states(widget)

                if name in by_name:
                    # A second widget sharing a name is a radio group's other
                    # option — PyMuPDF reports the kids, not the parent.
                    entry = by_name[name]
                    entry["type"] = "radio"
                    entry["options"].extend(o for o in on_states
                                            if o not in entry["options"])
                    entry["widgets"].append({
                        "page": index,
                        "rect": {"x": round(nr.x, 6), "y": round(nr.y, 6),
                                 "w": round(nr.w, 6), "h": round(nr.h, 6)},
                        "on_value": on_states[0] if on_states else "",
                    })
                    if widget.field_value and widget.field_value != "Off":
                        entry["value"] = widget.field_value
                    continue

                order.append(name)
                by_name[name] = {
                    "name": name,
                    "type": kind,
                    "page": index,
                    "rect": {"x": round(nr.x, 6), "y": round(nr.y, 6),
                             "w": round(nr.w, 6), "h": round(nr.h, 6)},
                    "value": "" if widget.field_value in (None, "Off", False)
                    else (widget.field_value if not isinstance(widget.field_value, bool)
                          else "Yes"),
                    "default": _default_of(doc, widget),
                    "align": _align_of(doc, widget),
                    "options": list(widget.choice_values or on_states),
                    "flags": {
                        "required": bool(flags & FF_REQUIRED),
                        "readonly": bool(flags & FF_READONLY),
                        "multiline": bool(flags & FF_MULTILINE),
                        "password": bool(flags & FF_PASSWORD),
                    },
                    "max_len": int(getattr(widget, "text_maxlen", 0) or 0),
                    "widgets": [{
                        "page": index,
                        "rect": {"x": round(nr.x, 6), "y": round(nr.y, 6),
                                 "w": round(nr.w, 6), "h": round(nr.h, 6)},
                        "on_value": on_states[0] if on_states else "",
                    }],
                }
        for entry in by_name.values():
            if entry["type"] == "radio" and entry["value"] not in entry["options"]:
                # A freshly created group carries PyMuPDF's generic "Yes" until
                # something is chosen; that is not one of the options, so it is
                # "nothing selected".
                entry["value"] = ""
        fields = [by_name[n] for n in order]
        return {
            "has_form": bool(fields),
            "is_xfa": xfa,
            "fields": fields,
        }
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Filling
# --------------------------------------------------------------------------- #
def _coerce(widget, value):
    """Turn a wire value into what this widget's `field_value` expects."""
    kind = _WIDGET_TO_TYPE.get(widget.field_type, "text")
    if kind == "checkbox":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"true", "yes", "on", "1", "checked"}
    if kind in {"combobox", "listbox"}:
        allowed = list(widget.choice_values or [])
        text = "" if value is None else str(value)
        if text and allowed and text not in allowed:
            raise InvalidParams(
                f"'{text}' is not an option for '{widget.field_name}' ({allowed})"
            )
        return text
    return "" if value is None else str(value)


def fill_form(data: bytes, *, values: dict, flatten_after: bool = False) -> tuple[bytes, dict]:
    """Set field values. Unknown names are reported, not silently ignored."""
    if not isinstance(values, dict) or not values:
        raise InvalidParams("`values` must be a non-empty object.")
    doc = _open(data)
    try:
        remaining = dict(values)
        # Counted by *field*, not by widget: a radio group is several widgets
        # and one answer, and "imported 3 field(s)" for one choice is a lie.
        touched: set[str] = set()
        for index in range(doc.page_count):
            page = doc[index]
            for widget in page.widgets():
                name = widget.field_name
                if name not in values:
                    continue
                target = values[name]
                kind = _WIDGET_TO_TYPE.get(widget.field_type, "text")
                if kind == "radio" or (kind == "checkbox" and _is_radio_kid(doc, widget)):
                    # Only the kid whose export value was chosen turns on; the
                    # others must be cleared, or two options read as selected.
                    on_states = _on_states(widget)
                    widget.field_value = (
                        str(target) if str(target) in on_states else "Off"
                    )
                else:
                    coerced = _coerce(widget, target)
                    widget.field_value = coerced
                    widget.update()
                    if coerced == "":
                        # `update()` will not write an empty `/V`, so a field
                        # keeps its old text — and "clear the form", which is
                        # half of the import round trip, silently did nothing.
                        doc.xref_set_key(widget.xref, "V", fitz.get_pdf_str(""))
                    touched.add(name)
                    remaining.pop(name, None)
                    continue
                widget.update()
                touched.add(name)
                remaining.pop(name, None)

        if remaining:
            raise InvalidParams(
                "This document has no field(s) called: " + ", ".join(sorted(remaining))
            )
        out = doc.tobytes(**_SAVE)
    finally:
        doc.close()

    if flatten_after:
        from .annotations import flatten_annotations

        out = flatten_annotations(out, what="form")
    return out, {"filled": len(touched), "flattened": bool(flatten_after)}


def _is_radio_kid(doc: fitz.Document, widget) -> bool:
    """A checkbox-shaped widget whose parent carries the radio flag."""
    ff_kind, ff = doc.xref_get_key(widget.xref, "Parent/Ff")
    if ff_kind == "null":
        return False
    try:
        return bool(int(str(ff)) & FF_RADIO)
    except ValueError:
        return False


# --------------------------------------------------------------------------- #
# Import / export
# --------------------------------------------------------------------------- #
def export_form_data(data: bytes, *, fmt: str = "json") -> tuple[bytes, str, str]:
    """Current values as JSON or CSV. Returns (bytes, filename, content_type)."""
    if fmt not in {"json", "csv"}:
        raise InvalidParams("format must be 'json' or 'csv'")
    model = read_form(data)
    values = {f["name"]: f["value"] for f in model["fields"]}
    if fmt == "json":
        return (json.dumps(values, indent=2, ensure_ascii=False).encode(),
                "form-data.json", "application/json")
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["name", "value"])
    for name, value in values.items():
        writer.writerow([name, value])
    return buf.getvalue().encode(), "form-data.csv", "text/csv"


def parse_form_data(payload: bytes, *, fmt: str = "json") -> dict:
    """JSON `{name: value}` or CSV (`name,value` rows, or a single wide row)."""
    if fmt not in {"json", "csv"}:
        raise InvalidParams("format must be 'json' or 'csv'")
    text = payload.decode("utf-8-sig", errors="replace")
    if fmt == "json":
        try:
            parsed = json.loads(text)
        except ValueError as exc:
            raise InvalidParams(f"that file is not valid JSON: {exc}") from exc
        if not isinstance(parsed, dict):
            raise InvalidParams("form data must be an object of {field: value}")
        return {str(k): v for k, v in parsed.items()}

    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise InvalidParams("that CSV is empty")
    header = [c.strip().lower() for c in rows[0]]
    if header[:2] == ["name", "value"]:
        return {r[0]: (r[1] if len(r) > 1 else "") for r in rows[1:] if r and r[0]}
    # Wide form: a header row of field names and one row of values.
    if len(rows) < 2:
        raise InvalidParams(
            "that CSV has headers but no values; expected either name,value rows "
            "or a header row of field names followed by one row of values"
        )
    names = [c.strip() for c in rows[0]]
    values = rows[1]
    return {n: (values[i] if i < len(values) else "") for i, n in enumerate(names) if n}


# --------------------------------------------------------------------------- #
# Field creation / editing
# --------------------------------------------------------------------------- #
def _rect_for(spec: dict, page: fitz.Page) -> fitz.Rect:
    """Widgets are annotations — the page's unrotated space (§8)."""
    try:
        norm = NormRect.from_dict(spec.get("rect"))
    except ValueError as exc:
        raise InvalidParams(f"invalid rect: {exc}") from exc
    x0, y0, x1, y1 = norm_to_page_rect(norm, page.rect.width, page.rect.height)
    x0, y0, x1, y1 = apply_matrix_rect(x0, y0, x1, y1, tuple(page.derotation_matrix))
    return fitz.Rect(x0, y0, x1, y1)


def _flags_from(spec: dict, base: int = 0) -> int:
    flags = base
    if spec.get("required"):
        flags |= FF_REQUIRED
    if spec.get("readonly"):
        flags |= FF_READONLY
    if spec.get("multiline"):
        flags |= FF_MULTILINE
    return flags


def _add_simple_field(page: fitz.Page, spec: dict) -> None:
    kind = spec["type"]
    widget = fitz.Widget()
    widget.field_name = spec["name"]
    widget.rect = _rect_for(spec, page)
    widget.field_flags = _flags_from(spec)
    if spec.get("font_size"):
        widget.text_fontsize = float(spec["font_size"])

    if kind == "text":
        widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        widget.field_value = str(spec.get("default") or "")
        if spec.get("max_len"):
            widget.text_maxlen = int(spec["max_len"])
    elif kind == "checkbox":
        widget.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
        widget.field_value = bool(spec.get("default"))
    elif kind in {"combobox", "listbox"}:
        options = [str(o) for o in (spec.get("options") or [])]
        if not options:
            raise InvalidParams(f"'{spec['name']}' needs at least one option")
        widget.field_type = (fitz.PDF_WIDGET_TYPE_COMBOBOX if kind == "combobox"
                             else fitz.PDF_WIDGET_TYPE_LISTBOX)
        widget.choice_values = options
        default = str(spec.get("default") or options[0])
        if default not in options:
            raise InvalidParams(f"default '{default}' is not one of {options}")
        widget.field_value = default
    else:
        raise InvalidParams(f"unsupported field type '{kind}'")
    added = page.add_widget(widget)

    align = spec.get("align")
    if align:
        if align not in _ALIGN:
            raise InvalidParams(f"align must be one of {list(_ALIGN)}")
        # `/Q` — quadding. PyMuPDF's Widget has no attribute for it, so it goes
        # in by hand after the widget exists.
        xref = getattr(added, "xref", 0) or widget.xref
        page.parent.xref_set_key(xref, "Q", str(_ALIGN[align]))


def _build_radio_group(raw: bytes, spec: dict) -> bytes:
    """Write a radio group as one parent field with N kid widgets.

    PyMuPDF's own radio widget cannot do this — see the module docstring — so
    the kids are created as checkboxes and then re-parented, with each kid's
    "on" appearance state renamed to its export value. That renaming is what
    makes the options distinguishable and gives the group its exclusivity.
    """
    import pikepdf

    options = [str(o) for o in (spec.get("options") or [])]
    if len(options) < 2:
        raise InvalidParams(f"radio group '{spec['name']}' needs at least two options")
    name = spec["name"]
    page_index = int(spec.get("page", 0))
    rects = spec.get("rects") or []
    if len(rects) != len(options):
        raise InvalidParams(
            f"radio group '{name}' needs one rect per option "
            f"({len(options)} options, {len(rects)} rects)"
        )

    doc = _open(raw)
    try:
        page = _page(doc, page_index)
        for option, rect in zip(options, rects):
            widget = fitz.Widget()
            widget.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
            # Temporary unique names; the kids lose /T when re-parented.
            # A printable separator, not NUL: a NUL byte does not survive the
            # round trip through PyMuPDF's string writer, so the pikepdf pass
            # found no kids and quietly produced two loose checkboxes.
            widget.field_name = f"{name}{_RADIO_SEP}{option}"
            widget.rect = _rect_for({"rect": rect}, page)
            widget.field_value = True
            page.add_widget(widget)
        staged = doc.tobytes(**_SAVE)
    finally:
        doc.close()

    pdf = pikepdf.open(io.BytesIO(staged))
    try:
        default = str(spec.get("default") or "")
        parent = pdf.make_indirect(pikepdf.Dictionary(
            FT=pikepdf.Name.Btn,
            T=pikepdf.String(name),
            Ff=_flags_from(spec, FF_RADIO),
            V=pikepdf.Name("/" + default) if default in options else pikepdf.Name("/Off"),
            Kids=pikepdf.Array([]),
        ))
        kids = []
        page_obj = pdf.pages[page_index]
        for annot in list(page_obj.get("/Annots") or []):
            title = str(annot.get("/T", ""))
            if not title.startswith(f"{name}{_RADIO_SEP}"):
                continue
            option = title.split(_RADIO_SEP, 1)[1]
            appearance = annot.AP.N
            on_keys = [k for k in appearance.keys() if k != "/Off"]
            if on_keys:
                appearance[pikepdf.Name("/" + option)] = appearance[on_keys[0]]
                if on_keys[0] != "/" + option:
                    del appearance[on_keys[0]]
            del annot["/T"]
            annot.Parent = parent
            annot.AS = pikepdf.Name("/" + option) if option == default else pikepdf.Name("/Off")
            kids.append(annot)
        parent.Kids = pikepdf.Array(kids)

        acro = pdf.Root.AcroForm
        fields = [f for f in (acro.get("/Fields") or [])
                  if not str(f.get("/T", "")).startswith(f"{name}{_RADIO_SEP}")]
        fields.append(parent)
        acro.Fields = pikepdf.Array(fields)

        buf = io.BytesIO()
        pdf.save(buf)
        return buf.getvalue()
    finally:
        pdf.close()


def _add_signature_field(raw: bytes, spec: dict) -> bytes:
    """Route `type=signature` through pyHanko (phase-05).

    The result is an empty signature field — a visual placeholder for signing.
    Filling it with an end-user certificate is out of scope; phase 8 stamps a
    signature image and applies the platform seal.
    """
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields as sig_fields

    doc = _open(raw)
    try:
        page = _page(doc, int(spec.get("page", 0)))
        rect = _rect_for(spec, page)
        # pyHanko boxes are PDF-native (origin bottom-left) — the one conversion
        # §8 sanctions, and it lives in `geometry.py` with every other one.
        box = page_rect_to_pdf_native(rect.x0, rect.y0, rect.x1, rect.y1, page)
        page_number = int(spec.get("page", 0))
    finally:
        doc.close()

    writer = IncrementalPdfFileWriter(io.BytesIO(raw))
    try:
        sig_fields.append_signature_field(
            writer,
            sig_fields.SigFieldSpec(
                sig_field_name=spec["name"], on_page=page_number, box=box,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        raise InvalidParams(f"could not add signature field: {exc}") from exc
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _delete_field(raw: bytes, name: str) -> bytes:
    doc = _open(raw)
    try:
        removed = 0
        for index in range(doc.page_count):
            page = doc[index]
            for widget in list(page.widgets()):
                if widget.field_name == name:
                    page.delete_widget(widget)
                    removed += 1
        if not removed:
            raise InvalidParams(f"no field called '{name}'")
        return doc.tobytes(**_SAVE)
    finally:
        doc.close()


def _existing_names(raw: bytes) -> set[str]:
    doc = _open(raw)
    try:
        return {w.field_name for i in range(doc.page_count) for w in doc[i].widgets()
                if w.field_name}
    finally:
        doc.close()


def edit_fields_batch(data: bytes, *, ops: list[dict]) -> tuple[bytes, dict]:
    """One pass of add/update/delete field ops → one new version (phase-05)."""
    if not isinstance(ops, list) or not ops:
        raise InvalidParams("`ops` must be a non-empty list.")
    current = data
    report = {"added": 0, "updated": 0, "deleted": 0}

    for op in ops:
        action = (op or {}).get("action")
        spec = (op or {}).get("field") or {}
        name = str(spec.get("name") or "")
        if action not in {"add", "update", "delete"}:
            raise InvalidParams(f"unknown field action '{action}'")
        if not name:
            raise InvalidParams("every field op needs a `field.name`")

        if action == "delete":
            current = _delete_field(current, name)
            report["deleted"] += 1
            continue

        existing = _existing_names(current)
        if action == "add" and name in existing:
            raise InvalidParams(
                f"a field called '{name}' already exists; names must be unique"
            )
        if action == "update":
            if name not in existing:
                raise InvalidParams(f"no field called '{name}' to update")
            # Update = replace. A field's type, options and geometry can all
            # change at once, and PyMuPDF has no coherent in-place path for
            # that (its radio and signature widgets cannot be mutated at all).
            current = _delete_field(current, name)

        kind = spec.get("type")
        if kind not in FIELD_TYPES:
            raise InvalidParams(f"field type must be one of {list(FIELD_TYPES)}")
        if kind == "radio":
            current = _build_radio_group(current, spec)
        elif kind == "signature":
            current = _add_signature_field(current, spec)
        else:
            doc = _open(current)
            try:
                _add_simple_field(_page(doc, spec.get("page", 0)), spec)
                current = doc.tobytes(**_SAVE)
            finally:
                doc.close()
        report["updated" if action == "update" else "added"] += 1

    return current, report
