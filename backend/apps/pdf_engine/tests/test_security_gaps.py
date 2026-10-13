"""Sanitize against hand-built hiding places (phase-07; §17).

`booby-trapped.pdf` carries one of each trap, which is what the golden file
needs. It does not carry the *other* places the same trap can sit — a
catalog-level `/AA`, a page-level `/AA`, a widget whose `/A` and `/AA` both run
script, a hidden layer referenced through an `/OCMD` (singly and as an array),
a hidden form XObject drawn with `Do`, a marked-content section nested inside
an artifact, or an annotation pinned to a layer. Each of those is a line in
`security.py` that the fixture never reached, so each gets a PDF built with
pikepdf here, and the assertion is on the bytes: the thing is gone and the
count says so.
"""
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
    * a square annotation with `/OC` pointing at the off group
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
    page.Annots = Array([pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Square, Rect=Array([10, 10, 50, 50]), OC=off,
    ))])
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
    out, report = S.sanitize(_layered(), hidden_layers_flatten=True)
    # The two BDC sections and the one Do: three removals.
    assert report["hidden_layers_flatten"] == 3, report

    for secret in (b"OCMDSECRET", b"NESTEDSECRET", b"XOBJSECRET"):
        assert secret not in out, secret
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        text = doc[0].get_text()
    finally:
        doc.close()
    assert "VISIBLEONE" in text, "the artifact section went with it"
    assert "SHOWNLAYER" in text, "a visible layer was removed"


def test_flattening_drops_the_layer_references_from_annotations_and_resources():
    out, _ = S.sanitize(_layered(), hidden_layers_flatten=True)
    pdf = pikepdf.open(io.BytesIO(out))
    try:
        page = pdf.pages[0]
        assert "/OCProperties" not in pdf.Root
        assert "/Properties" not in page.Resources
        assert "/Fx0" not in (page.Resources.get("/XObject") or {})
        assert all("/OC" not in a for a in (page.get("/Annots") or []))
    finally:
        pdf.close()


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


def test_a_content_stream_that_will_not_parse_is_left_alone_rather_than_emptied():
    """Cutting sections out of a stream we cannot read would mean guessing
    where they end; the honest answer is to leave the page as it was and
    report nothing removed."""
    pdf = pikepdf.open(io.BytesIO(_base()))
    off = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Hidden")))
    pdf.Root.OCProperties = Dictionary(OCGs=Array([off]), D=Dictionary(OFF=Array([off])))
    page = pdf.pages[0]
    page.Resources.Properties = Dictionary(MC0=off)
    page.Contents = pdf.make_stream(b"BT /helv 12 Tf 20 60 Td (STILLHERE) Tj ET")
    data = _save(pdf)

    with mock.patch.object(pikepdf, "parse_content_stream",
                           side_effect=RuntimeError("unparseable")):
        out, report = S.sanitize(data, hidden_layers_flatten=True)
    assert report["hidden_layers_flatten"] == 0
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert "STILLHERE" in doc[0].get_text()
    finally:
        doc.close()


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

    out, report = S.sanitize(data, embedded_files=True)
    assert report["embedded_files"] == 1
    assert b"attached secret payload" not in out
    with pikepdf.open(io.BytesIO(out)) as cleaned:
        assert [str(a.Subtype) for a in cleaned.pages[0].Annots] == ["/Text"]
