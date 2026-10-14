"""Sanitize against hand-built hiding places (phase-07; §17).

`booby-trapped.pdf` carries one of each trap, which is what the golden file
needs. It does not carry the *other* places the same trap can sit — a
catalog-level `/AA`, a page-level `/AA`, a widget whose `/A` and `/AA` both run
script, a hidden layer referenced through an `/OCMD` (singly and as an array),
a hidden form XObject drawn with `Do`, or a marked-content section nested
inside an artifact. Each of those is a line in `security.py` that the fixture
never reached, so each gets a PDF built with pikepdf here, and the assertion is
on the bytes: the thing is gone and the count says so.
"""
import contextlib
import io
from unittest import mock

import fitz
import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from apps.pdf_engine.engine import security as S
from apps.pdf_engine.exceptions import EngineError, InvalidParams


def _base() -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=200, height=100)
    page.insert_text((20, 50), "visible text")
    try:
        return doc.tobytes()
    finally:
        doc.close()


def _save(pdf: pikepdf.Pdf) -> bytes:
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def _streams(data: bytes) -> bytes:
    """Every stream in the file, decoded.

    pikepdf and MuPDF both write streams Flate-compressed, so `b"x" in data`
    cannot find a string that sits in a stream, whether it was removed or not
    (the trap `test_redact.raw_text_bytes` describes).
    """
    with pikepdf.open(io.BytesIO(data)) as pdf:
        return b"".join(o.read_bytes() for o in pdf.objects
                        if isinstance(o, pikepdf.Stream))


def _js(code: str) -> Dictionary:
    return Dictionary(S=Name.JavaScript, JS=String(code))


# --------------------------------------------------------------------------- #
# Opening and parameters
# --------------------------------------------------------------------------- #
def test_bytes_that_are_not_a_pdf_are_an_unsupported_file():
    with pytest.raises(EngineError) as caught:
        S.read_permissions(b"not a pdf at all")
    assert caught.value.code == "unsupported_file"
    assert "Could not open" in str(caught.value)


def test_a_nonsense_modify_level_is_refused(fixture_bytes):
    with pytest.raises(InvalidParams, match="modify"):
        S.encrypt(fixture_bytes("text.pdf"), owner_password="o",
                  permissions={"modify": "sometimes"})


# --------------------------------------------------------------------------- #
# JavaScript in every hiding place
# --------------------------------------------------------------------------- #
@pytest.fixture
def scripted() -> bytes:
    """A catalog `/AA`, a page `/AA`, a screen annotation with both `/A` and `/AA`, and an
    ordinary URI link that must survive the script sweep."""
    pdf = pikepdf.open(io.BytesIO(_base()))
    pdf.Root.AA = Dictionary(WC=_js("app.alert('closing')"))
    page = pdf.pages[0]
    page.AA = Dictionary(O=_js("app.alert('page open')"))
    screen = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Screen, Rect=Array([10, 10, 50, 50]),
        A=_js("app.alert('clicked')"), AA=Dictionary(Fo=_js("app.alert('focus')")),
    ))
    link = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Link, Rect=Array([60, 10, 90, 50]),
        A=Dictionary(S=Name.URI, URI=String("https://example.com/")),
    ))
    page.Annots = Array([screen, link])
    return _save(pdf)


def test_the_fixture_really_carries_four_scripts(scripted):
    pdf = pikepdf.open(io.BytesIO(scripted))
    try:
        page = pdf.pages[0]
        assert "/AA" in pdf.Root and "/AA" in page
        assert "/A" in page.Annots[0] and "/AA" in page.Annots[0]
    finally:
        pdf.close()


def test_additional_actions_are_stripped_from_catalog_page_and_annotation(scripted):
    out, report = S.sanitize(scripted, javascript=True)
    assert report["javascript"] == 4, report
    pdf = pikepdf.open(io.BytesIO(out))
    try:
        page = pdf.pages[0]
        assert "/AA" not in pdf.Root
        assert "/AA" not in page
        kinds = {str(a.Subtype): a for a in page.Annots}
        assert "/A" not in kinds["/Screen"] and "/AA" not in kinds["/Screen"]
    finally:
        pdf.close()
    assert b"app.alert" not in out


def test_the_script_sweep_leaves_a_uri_link_action_alone(scripted):
    """Only `/S /JavaScript` actions are scripts; a link is navigation."""
    out, _ = S.sanitize(scripted, javascript=True)
    pdf = pikepdf.open(io.BytesIO(out))
    try:
        link = next(a for a in pdf.pages[0].Annots if str(a.Subtype) == "/Link")
        assert str(link.A.S) == "/URI"
    finally:
        pdf.close()


# --------------------------------------------------------------------------- #
# Hidden layers through every reference shape
# --------------------------------------------------------------------------- #
def _layered() -> bytes:
    """One off group and one on group, referenced four ways:

    * `MC0` → an `/OCMD` whose `/OCGs` is an *array* holding the off group
    * `MC1` → an `/OCMD` whose `/OCGs` is the off group *directly*
    * `MC2` → the on group (must be kept)
    * `Fx0` → a form XObject with `/OC` pointing at the off group
    """
    pdf = pikepdf.open(io.BytesIO(_base()))
    off = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Hidden")))
    on = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Shown")))
    pdf.Root.OCProperties = Dictionary(
        OCGs=Array([off, on]), D=Dictionary(OFF=Array([off]), ON=Array([on])),
    )
    page = pdf.pages[0]
    form = pdf.make_stream(b"BT /helv 12 Tf 20 20 Td (XOBJSECRET) Tj ET")
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array([0, 0, 200, 100])
    form.OC = off
    form.Resources = Dictionary(Font=page.Resources.Font)
    page.Resources.Properties = Dictionary(
        MC0=pdf.make_indirect(Dictionary(Type=Name.OCMD, OCGs=Array([off]))),
        MC1=pdf.make_indirect(Dictionary(Type=Name.OCMD, OCGs=off)),
        MC2=on,
    )
    page.Resources.XObject = Dictionary(Fx0=form)
    page.Contents = pdf.make_stream(
        b"/Artifact BMC BT /helv 12 Tf 20 80 Td (VISIBLEONE) Tj ET EMC "
        b"/OC /MC0 BDC BT /helv 12 Tf 20 60 Td (OCMDSECRET) Tj ET EMC "
        b"/OC /MC1 BDC /Artifact BMC BT /helv 12 Tf 20 40 Td (NESTEDSECRET) Tj ET EMC EMC "
        b"/OC /MC2 BDC BT /helv 12 Tf 20 30 Td (SHOWNLAYER) Tj ET EMC "
        b"q /Fx0 Do Q"
    )
    return _save(pdf)


def test_the_layered_fixture_hides_what_it_claims_to():
    doc = fitz.open(stream=_layered(), filetype="pdf")
    try:
        text = doc[0].get_text()
    finally:
        doc.close()
    assert "VISIBLEONE" in text and "SHOWNLAYER" in text
    assert "OCMDSECRET" not in text and "NESTEDSECRET" not in text


def test_hidden_content_is_cut_through_ocmd_nesting_and_xobjects():
    secrets = (b"OCMDSECRET", b"NESTEDSECRET", b"XOBJSECRET")
    layered = _layered()
    assert all(s in _streams(layered) for s in secrets), "the fixture never carried them"

    out, report = S.sanitize(layered, hidden_layers_flatten=True)
    # The two BDC sections and the one Do: three removals.
    assert report["hidden_layers_flatten"] == 3, report

    left = _streams(out)
    assert b"VISIBLEONE" in left, "the search cannot see text in what sanitize wrote"
    for secret in secrets:
        assert secret not in left, secret
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        text = doc[0].get_text()
    finally:
        doc.close()
    # With `/OCProperties` gone, anything that survived the cut would render.
    for secret in secrets:
        assert secret.decode() not in text, secret
    assert "VISIBLEONE" in text, "the artifact section went with it"
    assert "SHOWNLAYER" in text, "a visible layer was removed"


def test_flattening_drops_the_layer_references_from_resources():
    out, _ = S.sanitize(_layered(), hidden_layers_flatten=True)
    pdf = pikepdf.open(io.BytesIO(out))
    try:
        page = pdf.pages[0]
        assert "/OCProperties" not in pdf.Root
        assert "/Properties" not in page.Resources
        assert "/Fx0" not in (page.Resources.get("/XObject") or {})
    finally:
        pdf.close()


def test_no_annotation_keeps_a_layer_reference_after_flattening():
    """With `/OCProperties` gone, an annotation's `/OC` would point at a group
    that no longer exists. What becomes of the annotation on the *off* layer is
    deliberately not asserted: today its `/OC` is dropped like the other's, so
    it renders and is not counted. That is a product defect (it should be
    removed and counted like a cut section), not the contract."""
    pdf = pikepdf.open(io.BytesIO(_base()))
    off = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Hidden")))
    on = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Shown")))
    pdf.Root.OCProperties = Dictionary(
        OCGs=Array([off, on]), D=Dictionary(OFF=Array([off]), ON=Array([on])),
    )
    pdf.pages[0].Annots = Array([
        pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Square, Rect=Array([10, 10, 50, 50]), OC=off,
        )),
        pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Circle, Rect=Array([60, 10, 90, 50]), OC=on,
        )),
    ])
    out, _ = S.sanitize(_save(pdf), hidden_layers_flatten=True)
    with pikepdf.open(io.BytesIO(out)) as cleaned:
        annots = list(cleaned.pages[0].get("/Annots") or [])
        assert "/OCProperties" not in cleaned.Root
        assert all("/OC" not in a for a in annots)
        assert "/Circle" in {str(a.Subtype) for a in annots}, "a visible layer's annotation went"


def test_a_document_without_layers_reports_nothing_removed():
    _out, report = S.sanitize(_base(), hidden_layers_flatten=True)
    assert report["hidden_layers_flatten"] == 0


def test_a_layered_document_with_no_off_groups_reports_nothing_removed():
    """Flattening a visible layer is not removing something from the file."""
    pdf = pikepdf.open(io.BytesIO(_base()))
    on = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Shown")))
    pdf.Root.OCProperties = Dictionary(OCGs=Array([on]), D=Dictionary(ON=Array([on])))
    out, report = S.sanitize(_save(pdf), hidden_layers_flatten=True)
    assert report["hidden_layers_flatten"] == 0
    with pikepdf.open(io.BytesIO(out)) as cleaned:
        assert "/OCProperties" not in cleaned.Root


def test_a_page_that_references_no_hidden_group_is_left_untouched():
    """The cut runs per page; a page that draws nothing on the off layer is
    not parsed, let alone rewritten."""
    pdf = pikepdf.open(io.BytesIO(_base()))
    off = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Hidden")))
    pdf.Root.OCProperties = Dictionary(OCGs=Array([off]), D=Dictionary(OFF=Array([off])))
    with mock.patch.object(pikepdf, "parse_content_stream") as parse:
        out, report = S.sanitize(_save(pdf), hidden_layers_flatten=True)
    parse.assert_not_called()
    assert report["hidden_layers_flatten"] == 0
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert "visible text" in doc[0].get_text()
    finally:
        doc.close()


def test_is_off_resolves_every_reference_shape():
    pdf = pikepdf.new()
    off = pdf.make_indirect(Dictionary(Type=Name.OCG))
    on = pdf.make_indirect(Dictionary(Type=Name.OCG))
    hidden = {S._ident(off)}
    assert S._is_off(None, hidden) is False
    assert S._is_off(off, hidden) is True
    assert S._is_off(on, hidden) is False
    assert S._is_off(Dictionary(Type=Name.OCMD), hidden) is False
    assert S._is_off(Dictionary(Type=Name.OCMD, OCGs=off), hidden) is True
    assert S._is_off(Dictionary(Type=Name.OCMD, OCGs=Array([on, off])), hidden) is True
    assert S._is_off(Dictionary(Type=Name.OCMD, OCGs=Array([on])), hidden) is False


def test_a_content_stream_that_will_not_parse_is_not_rewritten():
    """Cutting sections out of a stream we cannot read would mean guessing
    where they end, so the cut leaves such a stream exactly as it was (a
    refusal would be honest too). What sanitize does with the page next is
    deliberately not asserted: today it drops `/OCProperties` anyway, which
    reveals any hidden section the stream holds while reporting nothing
    removed. That is a product defect, not the contract."""
    pdf = pikepdf.open(io.BytesIO(_base()))
    off = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Hidden")))
    page = pdf.pages[0]
    page.Resources.Properties = Dictionary(MC0=off)
    page.Contents = pdf.make_stream(b"BT /helv 12 Tf 20 60 Td (STILLHERE) Tj ET")
    before = page.Contents.read_bytes()

    with mock.patch.object(pikepdf, "parse_content_stream",
                           side_effect=RuntimeError("unparseable")), \
            contextlib.suppress(EngineError):
        S._cut_hidden_content(pdf, page, {S._ident(off)})
    assert page.Contents.read_bytes() == before


# --------------------------------------------------------------------------- #
# Attachments carried by annotations
# --------------------------------------------------------------------------- #
def test_a_file_attachment_annotation_is_removed_and_counted():
    pdf = pikepdf.open(io.BytesIO(_base()))
    spec = pdf.make_indirect(Dictionary(
        Type=Name.Filespec, F=String("secret.txt"),
        EF=Dictionary(F=pdf.make_stream(b"attached secret payload")),
    ))
    attachment = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.FileAttachment, Rect=Array([10, 10, 30, 30]), FS=spec,
    ))
    note = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Text, Rect=Array([40, 10, 60, 30]),
        Contents=String("a sticky note"),
    ))
    pdf.pages[0].Annots = Array([attachment, note])
    data = _save(pdf)
    assert b"attached secret payload" in _streams(data), "the fixture carries no payload"

    out, report = S.sanitize(data, embedded_files=True)
    assert report["embedded_files"] == 1
    assert b"attached secret payload" not in _streams(out)
    with pikepdf.open(io.BytesIO(out)) as cleaned:
        assert [str(a.Subtype) for a in cleaned.pages[0].Annots] == ["/Text"]
