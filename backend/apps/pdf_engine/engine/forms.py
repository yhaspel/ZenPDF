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

# How many distinct fields the read model will report — see `read_form`.
MAX_FIELDS = 2000

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


def _decode_pdf_name(token: str) -> str:
    """`Option#201` → `Option 1`.

    A radio option is stored as a PDF **name**, so pikepdf escapes anything not
    name-safe — a space, `/`, `#`, or any non-ASCII byte — on the way in. PyMuPDF
    hands the raw token straight back, so without decoding here the read model
    advertised `Option#201` as the option, the client sent back either spelling,
    and neither matched: the group could not be selected at all, and every
    builder round trip escaped the escape (`Option#23201`, `Option#2323201`, …).
    """
    out = bytearray()
    i = 0
    while i < len(token):
        pair = token[i + 1:i + 3]
        if token[i] == "#" and len(pair) == 2 and all(c in "0123456789abcdefABCDEF" for c in pair):
            out.append(int(pair, 16))
            i += 3
        else:
            out.extend(token[i].encode("utf-8"))
            i += 1
    return out.decode("utf-8", errors="replace")


def _on_states(widget) -> list[str]:
    """The raw `/AP /N` on-state tokens, exactly as stored — what `field_value`
    has to be set to. `_on_labels` is the same list for human consumption."""
    states = widget.button_states() or {}
    normal = states.get("normal") or []
    return [s.lstrip("/") for s in normal if s and s.lstrip("/") != "Off"]


def _on_labels(widget) -> list[str]:
    return [_decode_pdf_name(s) for s in _on_states(widget)]


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


def _font_size_of(doc: fitz.Document, widget) -> float:
    """The size out of `/DA` (`… /Helv 12 Tf`), so the panel can carry it.

    An update is delete-then-add from the spec the client sends, so anything
    the read model does not report is silently reset the first time a field is
    dragged.
    """
    size = float(getattr(widget, "text_fontsize", 0) or 0)
    if size:
        return size
    for path in ("DA", "Parent/DA"):
        kind, raw = doc.xref_get_key(widget.xref, path)
        if kind != "string":
            continue
        parts = str(raw).split()
        if "Tf" in parts:
            try:
                return float(parts[parts.index("Tf") - 1])
            except (ValueError, IndexError):
                return 0.0
    return 0.0


def read_form(data: bytes) -> dict:
    """The form read model (phase-05 §"Read model")."""
    doc = _open(data)
    try:
        xfa = is_xfa(doc)
        by_name: dict[str, dict] = {}
        order: list[str] = []
        truncated = False
        for index in range(doc.page_count):
            page = doc[index]
            pw, ph = page.rect.width, page.rect.height
            rot = tuple(page.rotation_matrix)
            for widget in page.widgets():
                name = widget.field_name or ""
                if not name:
                    continue
                if name not in by_name and len(order) >= MAX_FIELDS:
                    # This endpoint scans every page synchronously and answers
                    # in one unpaginated response. Measured: a 6.3 MB PDF with
                    # 30 000 widgets — inside the guest caps — cost 4.3 s of API
                    # CPU and an 11 MB response, repeatable at the throttle
                    # limit. No real form has 2 000 fields; one that claims to
                    # is a lever, so it is reported as truncated instead.
                    truncated = True
                    continue
                kind = _WIDGET_TO_TYPE.get(widget.field_type, "text")
                is_radio = kind == "radio" or (kind == "checkbox"
                                               and _is_radio_kid(doc, widget))
                flags = _flags_of(widget)
                rect = widget.rect
                x0, y0, x1, y1 = apply_matrix_rect(rect.x0, rect.y0, rect.x1, rect.y1, rot)
                nr = page_rect_to_norm_clamped(x0, y0, x1, y1, pw, ph)
                labels = _on_labels(widget)
                placement = {
                    "page": index,
                    "rect": {"x": round(nr.x, 6), "y": round(nr.y, 6),
                             "w": round(nr.w, 6), "h": round(nr.h, 6)},
                    "on_value": labels[0] if labels else "",
                }

                if name in by_name:
                    # A second widget with the same name is *either* a radio
                    # group's other option or the same field placed on several
                    # pages — a name/date repeated on every page of a contract
                    # is the commonest AcroForm shape there is. Calling that a
                    # radio group left it with no options, which then made the
                    # "nothing selected" cleanup below erase the real value and
                    # left the UI rendering a choice list with no choices.
                    entry = by_name[name]
                    entry["widgets"].append(placement)
                    if is_radio:
                        entry["type"] = "radio"
                        entry["options"].extend(o for o in labels
                                                if o not in entry["options"])
                        chosen = _decode_pdf_name(str(widget.field_value or ""))
                        if chosen and chosen != "Off":
                            entry["value"] = chosen
                    continue

                order.append(name)
                by_name[name] = {
                    "name": name,
                    "type": "radio" if is_radio else kind,
                    "page": index,
                    "rect": {"x": round(nr.x, 6), "y": round(nr.y, 6),
                             "w": round(nr.w, 6), "h": round(nr.h, 6)},
                    "value": "" if widget.field_value in (None, "Off", False)
                    else (_decode_pdf_name(widget.field_value)
                          if not isinstance(widget.field_value, bool) else "Yes"),
                    "default": _default_of(doc, widget),
                    "align": _align_of(doc, widget),
                    "font_size": _font_size_of(doc, widget),
                    "options": list(widget.choice_values or labels),
                    "flags": {
                        "required": bool(flags & FF_REQUIRED),
                        "readonly": bool(flags & FF_READONLY),
                        "multiline": bool(flags & FF_MULTILINE),
                        "password": bool(flags & FF_PASSWORD),
                    },
                    "max_len": int(getattr(widget, "text_maxlen", 0) or 0),
                    "widgets": [placement],
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
            "truncated": truncated,
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
                f"'{text[:80]}' is not an option for '{widget.field_name}' ({allowed})"
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
        radio_targets: dict[str, str] = {}
        for index in range(doc.page_count):
            page = doc[index]
            for widget in page.widgets():
                name = widget.field_name
                if name not in values:
                    continue
                target = values[name]
                kind = _WIDGET_TO_TYPE.get(widget.field_type, "text")
                if kind == "signature":
                    # A signature field holds a signature dictionary, not text.
                    # Writing an empty `/V` string onto one — which is exactly
                    # what an export→import round trip used to do, since the
                    # export listed it with an empty value — makes pyHanko
                    # refuse it ("appears to be filled already") and bricks the
                    # placeholder Phase 8 is meant to sign into.
                    if str(target or "").strip():
                        raise InvalidParams(
                            f"'{name}' is a signature field; it is signed, not filled in."
                        )
                    touched.add(name)
                    remaining.pop(name, None)
                    continue
                if kind == "radio" or (kind == "checkbox" and _is_radio_kid(doc, widget)):
                    # Deferred to a pikepdf pass below. Setting `field_value` on
                    # a kid works only while the export values happen to be
                    # bare PDF names: PyMuPDF re-escapes whatever it is handed,
                    # so `a/b` (stored `a#2fb`) became `a#232fb` and matched
                    # nothing — the group silently stayed unselected.
                    radio_targets[name] = str(target)
                    touched.add(name)
                    remaining.pop(name, None)
                    continue

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

        if remaining:
            # Truncated: the caller controls both the count and the length of
            # these names, and the message is persisted on the Job row and
            # echoed on every poll. An import of 90 000 unknown names produced a
            # 900 KB error message.
            names = sorted(remaining)
            shown = ", ".join(n[:80] for n in names[:20])
            more = f" (and {len(names) - 20} more)" if len(names) > 20 else ""
            raise InvalidParams(f"This document has no field(s) called: {shown}{more}")
        out = doc.tobytes(**_SAVE)
    finally:
        doc.close()

    if radio_targets:
        out = _select_radio_options(out, radio_targets)

    if flatten_after:
        from .annotations import flatten_annotations

        out = flatten_annotations(out, what="form")
    return out, {"filled": len(touched), "flattened": bool(flatten_after)}


def _select_radio_options(raw: bytes, choices: dict[str, str]) -> bytes:
    """Choose one option per radio group, at the PDF level.

    The parent field carries `/V` and each kid carries `/AS` — exactly one on,
    the rest `/Off`, which is what makes a group exclusive. Done here rather
    than through PyMuPDF because `field_value` re-escapes what it is given, so
    any option that is not already a bare PDF name could never be selected.
    """
    import pikepdf

    def on_states(kid) -> list[str]:
        """The `/AP /N` keys as plain strings — pikepdf hands back `"/basic"`,
        not a Name, and assigning that string writes a *string* object."""
        appearance = kid.get("/AP", {}).get("/N", {})
        return [str(k) for k in appearance.keys() if str(k) != "/Off"]

    pdf = pikepdf.open(io.BytesIO(raw))
    try:
        acro = pdf.Root.get("/AcroForm")
        for field in list((acro or {}).get("/Fields") or []):  # type: ignore[call-overload]
            name = str(field.get("/T", ""))
            if name not in choices:
                continue
            wanted = choices[name]
            kids = list(field.get("/Kids") or [])
            targets = kids or [field]
            chosen = None
            for kid in targets:
                match = next(
                    (s for s in on_states(kid)
                     if _decode_pdf_name(s.lstrip("/")) == wanted), None)
                kid.AS = pikepdf.Name(match) if match else pikepdf.Name("/Off")
                if match:
                    chosen = match
                if kids and "/V" in kid:
                    del kid["/V"]   # the answer belongs to the parent
            field.V = pikepdf.Name(chosen) if chosen else pikepdf.Name("/Off")
        buf = io.BytesIO()
        pdf.save(buf)
        return buf.getvalue()
    finally:
        pdf.close()


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
def _csv_safe(cell) -> str:
    """Defuse a spreadsheet formula (CWE-1236).

    Field names and values come out of a PDF somebody else may have written,
    and Export CSV is one click away — so `=cmd|' /C calc'!A0` in a text field
    would execute when the victim opens the export in Excel. A leading
    apostrophe is the standard neutraliser and survives a round trip back
    through `parse_form_data` as a literal.
    """
    text = "" if cell is None else str(cell)
    return "'" + text if text[:1] in {"=", "+", "-", "@", "\t", "\r"} else text


def export_form_data(data: bytes, *, fmt: str = "json") -> tuple[bytes, str, str]:
    """Current values as JSON or CSV. Returns (bytes, filename, content_type)."""
    if fmt not in {"json", "csv"}:
        raise InvalidParams("format must be 'json' or 'csv'")
    model = read_form(data)
    # Signature fields are excluded on purpose: they have no value to export,
    # and importing the empty one back writes `/V ()` onto a `/Sig` field,
    # which permanently un-signs it.
    values = {f["name"]: f["value"] for f in model["fields"] if f["type"] != "signature"}
    if fmt == "json":
        return (json.dumps(values, indent=2, ensure_ascii=False).encode(),
                "form-data.json", "application/json")
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["name", "value"])
    for name, value in values.items():
        writer.writerow([_csv_safe(name), _csv_safe(value)])
    return buf.getvalue().encode(), "form-data.csv", "text/csv"


def parse_form_data(payload: bytes, *, fmt: str = "json") -> dict:
    """JSON `{name: value}` or CSV (`name,value` rows, or a single wide row).

    A `name,value` header wins when both readings are possible — it is what our
    own export writes. The two shapes are genuinely indistinguishable for a form
    whose fields are *called* `name` and `value`, which is why the preference is
    stated here rather than guessed at per file.
    """
    if fmt not in {"json", "csv"}:
        raise InvalidParams("format must be 'json' or 'csv'")
    text = payload.decode("utf-8-sig", errors="replace")
    if fmt == "json":
        try:
            parsed = json.loads(text)
        except (ValueError, RecursionError) as exc:
            # RecursionError: 300 000 nested `[` is well inside the size cap and
            # blows the decoder's stack — a 400, not a 500.
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
        norm = NormRect.from_dict(spec.get("rect") or {})
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
    xref_of = getattr(added, "xref", 0) or widget.xref

    if spec.get("default") not in (None, "", False):
        # `/DV` as well as `/V`: the spec's `default` is what "reset form" puts
        # back, and PyMuPDF only ever writes the current value.
        page.parent.xref_set_key(xref_of, "DV", fitz.get_pdf_str(str(spec["default"])))

    align = spec.get("align")
    if align:
        if align not in _ALIGN:
            raise InvalidParams(f"align must be one of {list(_ALIGN)}")
        # `/Q` — quadding. PyMuPDF's Widget has no attribute for it, so it goes
        # in by hand after the widget exists.
        page.parent.xref_set_key(xref_of, "Q", str(_ALIGN[align]))


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
        kid_ids = set()
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
            # Identity, captured *before* `/T` goes: the old filter matched the
            # `/AcroForm/Fields` entries by title after this line had already
            # removed it, so it never matched and every kid stayed registered as
            # a top-level field as well as a `/Kids` entry.
            if annot.is_indirect:
                kid_ids.add(annot.objgen)
            del annot["/T"]
            # `field_value = True` left each kid holding `/V /Yes`; the answer
            # belongs to the parent, and a kid carrying its own beats it.
            if "/V" in annot:
                del annot["/V"]
            annot.Parent = parent
            annot.AS = pikepdf.Name("/" + option) if option == default else pikepdf.Name("/Off")
            kids.append(annot)
        parent.Kids = pikepdf.Array(kids)

        acro = pdf.Root.AcroForm
        fields = [f for f in ((acro.get("/Fields") if acro is not None else None) or [])
                  if not (f.is_indirect and f.objgen in kid_ids)]
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
                # pyHanko annotates `box` as ints and writes `FloatObject`s
                # from it; ints here would truncate the placement.
                sig_field_name=spec["name"], on_page=page_number,
                box=box,  # type: ignore[arg-type]
            ),
        )
    except Exception as exc:  # noqa: BLE001
        raise InvalidParams(f"could not add signature field: {exc}") from exc
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _prune_acroform_field(raw: bytes, name: str) -> tuple[bytes, int]:
    """Drop `/AcroForm/Fields` entries called `name`. Returns (bytes, removed).

    Deleting the widget annotations is not enough for a radio group: the group
    is a *parent* field object with no annotation of its own, so it survived as
    a ghost entry whose `/Kids` pointed at deleted annots — invisible to the
    app, visible to Acrobat and to any later pyHanko pass, and impossible to
    remove afterwards because no widget carried the name any more. Update is
    delete-then-add, so the same document ended up with the name twice.
    """
    import pikepdf

    pdf = pikepdf.open(io.BytesIO(raw))
    try:
        acro = pdf.Root.get("/AcroForm")
        if acro is None:
            return raw, 0
        fields = list((acro.get("/Fields") if acro is not None else None) or [])
        kept = [f for f in fields if str(f.get("/T", "")) != name]
        if len(kept) == len(fields):
            return raw, 0
        acro.Fields = pikepdf.Array(kept)
        buf = io.BytesIO()
        pdf.save(buf)
        return buf.getvalue(), len(fields) - len(kept)
    finally:
        pdf.close()


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
        out = doc.tobytes(**_SAVE)
    finally:
        doc.close()

    out, pruned = _prune_acroform_field(out, name)
    if not removed and not pruned:
        raise InvalidParams(f"no field called '{name}'")
    return out


def _existing_names(raw: bytes) -> set[str]:
    """Every field name in the file — widgets *and* parent-only fields.

    The parent half matters: a radio group's name lives on a field object with
    no annotation, so a widget-only scan called the name free and let `add`
    create a second field with it.
    """
    import pikepdf

    names: set[str] = set()
    doc = _open(raw)
    try:
        for index in range(doc.page_count):
            # Bound to a local: `doc[i].widgets()` lets the temporary Page be
            # collected while its widgets are still in use (annotations.py).
            page = doc[index]
            names.update(w.field_name for w in page.widgets() if w.field_name)
    finally:
        doc.close()

    pdf = pikepdf.open(io.BytesIO(raw))
    try:
        acro = pdf.Root.get("/AcroForm")
        for field in list((acro or {}).get("/Fields") or []):  # type: ignore[call-overload]
            title = str(field.get("/T", ""))
            if title:
                names.add(title)
    finally:
        pdf.close()
    return names


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
