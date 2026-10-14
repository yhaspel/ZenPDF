"""The conversion branches `test_convert.py` leaves to the Gotenberg container.

The golden file skips the office/HTML/URL routes when Gotenberg is not running,
which means the *error handling* around the HTTP call — a timeout, a refused
connection, a non-200 with or without a body, a 200 that is not a PDF — was
never exercised anywhere a CI run could see it. Here `requests.post` is
patched at the boundary and every one of those answers is asserted to come
back as the `EngineError` the worker maps onto a job code, rather than as a
`requests` exception nobody catches. The specialist exporters (pdf2docx,
pymupdf4llm, OCRmyPDF) are patched the same way for their failure branches.
"""
import io
import zipfile
from unittest import mock

import fitz
import pytest
import requests

from apps.pdf_engine.engine import convert as C
from apps.pdf_engine.exceptions import EngineError, InvalidParams, UnsupportedFileError


def _png(size=(120, 80)) -> bytes:
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, *size))
    pix.set_rect(pix.irect, (255, 0, 0))
    return pix.tobytes("png")


def _one_page_pdf() -> bytes:
    doc = fitz.open()
    doc.new_page()
    try:
        return doc.tobytes()
    finally:
        doc.close()


def _response(status: int, content: bytes = b"", text: str = ""):
    response = mock.Mock()
    response.status_code = status
    response.content = content
    response.text = text
    return response


# --------------------------------------------------------------------------- #
# Image input validation
# --------------------------------------------------------------------------- #
def test_an_unknown_fit_is_refused_before_any_image_is_opened():
    with pytest.raises(InvalidParams, match="fit"):
        C.images_to_pdf([_png()], fit="stretch")


def test_an_empty_image_list_is_refused():
    with pytest.raises(InvalidParams, match="No images"):
        C.images_to_pdf([])


def test_one_unreadable_image_among_good_ones_fails_the_whole_conversion():
    """A silently dropped page is worse than a refusal: the user sent three
    scans and would get back a two-page PDF with no indication which one was
    lost."""
    with pytest.raises(UnsupportedFileError, match="could not be read"):
        C.images_to_pdf([_png(), b"\x89PNG\r\n\x1a\nbroken", _png()])


def test_convert_from_with_nothing_to_convert_says_so():
    with pytest.raises(InvalidParams, match="Nothing to convert"):
        C.convert_from()


def test_convert_from_prefers_the_image_list_over_a_file():
    out, title = C.convert_from(images=[_png(), _png()], data=b"ignored",
                                filename="ignored.docx")
    assert title == "Images"
    doc = fitz.open(stream=out, filetype="pdf")
    try:
        assert doc.page_count == 2
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# The archive guard
# --------------------------------------------------------------------------- #
def test_a_damaged_zip_container_is_refused_as_damaged_not_as_a_crash():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("word/document.xml", "<w:p>hello</w:p>")
    data = bytearray(buf.getvalue())
    # Corrupt the local file header so the central directory still parses
    # (is_zipfile says yes) but reading the entry fails.
    data[0:4] = b"XXXX"

    with pytest.raises(UnsupportedFileError, match="damaged"):
        C.check_archive(bytes(data), "letter.docx")


def test_a_file_that_is_not_a_container_is_not_inspected(monkeypatch):
    """`.rtf`, `.txt`, `.csv` and the legacy `.doc` are not zips; the budget
    does not apply and must not refuse them."""
    monkeypatch.setattr(C, "MAX_ARCHIVE_UNCOMPRESSED_BYTES", 4)
    C.check_archive(b"{\\rtf1 a much longer body than four bytes}", "memo.rtf")


def test_directory_entries_do_not_count_against_the_budget(monkeypatch):
    """A docx carries a directory entry per folder. They are skipped by
    `is_dir()`, not measured, so one here carries bytes: read, it would take
    the 10 bytes of content to 18, over the budget of 16."""
    monkeypatch.setattr(C, "MAX_ARCHIVE_UNCOMPRESSED_BYTES", 16)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("word/", b"x" * 8)
        archive.writestr("word/media/", "")
        archive.writestr("word/document.xml", "0123456789")
    C.check_archive(buf.getvalue(), "small.docx")  # 10 bytes of content: fine
    with zipfile.ZipFile(buf, "a") as archive:
        archive.writestr("word/styles.xml", "0123456789")
    with pytest.raises(UnsupportedFileError, match="more than we will convert"):
        C.check_archive(buf.getvalue(), "small.docx")  # 20 bytes: over


# --------------------------------------------------------------------------- #
# The probe
# --------------------------------------------------------------------------- #
def test_the_probe_refuses_an_empty_result():
    with pytest.raises(EngineError) as caught:
        C._probe(b"", "Converting that document")
    assert caught.value.code == "conversion_failed"
    assert "empty file" in str(caught.value)


def test_the_probe_refuses_a_pdf_with_no_pages():
    """MuPDF opens a zero-page PDF without complaint; a user cannot."""
    raw = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
           b"2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>")
    with pytest.raises(EngineError, match="no pages") as caught:
        C._probe(raw, "That file")
    assert caught.value.code == "conversion_failed"


def test_the_probe_refuses_a_png_wearing_a_pdf_extension():
    with pytest.raises(EngineError, match="did not produce a PDF"):
        C.convert_from(data=_png(), filename="photo.pdf")


# --------------------------------------------------------------------------- #
# Gotenberg, with the HTTP call patched at the boundary
# --------------------------------------------------------------------------- #
def test_a_gotenberg_timeout_is_an_engine_timeout():
    with mock.patch("requests.post", side_effect=requests.Timeout("slow")):
        with pytest.raises(EngineError) as caught:
            C.office_to_pdf(b"data", "letter.docx")
    assert caught.value.code == "engine_timeout"
    assert "too long" in str(caught.value)


def test_an_unreachable_converter_is_a_conversion_failure():
    with mock.patch("requests.post",
                    side_effect=requests.ConnectionError("refused")):
        with pytest.raises(EngineError) as caught:
            C.html_to_pdf(b"<p>hi</p>", "page.html")
    assert caught.value.code == "conversion_failed"
    assert "could not reach" in str(caught.value)


def test_a_non_200_with_a_body_quotes_the_body():
    with mock.patch("requests.post",
                    return_value=_response(422, text="unsupported format: .xyz")):
        with pytest.raises(EngineError) as caught:
            C.office_to_pdf(b"data", "letter.docx")
    assert caught.value.code == "conversion_failed"
    assert "unsupported format: .xyz" in str(caught.value)


def test_a_non_200_without_a_body_quotes_the_status():
    with mock.patch("requests.post", return_value=_response(503, text="")):
        with pytest.raises(EngineError, match="503"):
            C.office_to_pdf(b"data", "letter.docx")


def test_a_long_error_body_is_truncated():
    with mock.patch("requests.post",
                    return_value=_response(500, text="x" * 2000)):
        with pytest.raises(EngineError) as caught:
            C.office_to_pdf(b"data", "letter.docx")
    assert len(str(caught.value)) < 400


def test_a_200_that_is_not_a_pdf_is_caught_by_the_probe():
    with mock.patch("requests.post",
                    return_value=_response(200, content=b"<html>oops</html>")):
        with pytest.raises(EngineError, match="did not produce a PDF"):
            C.office_to_pdf(b"data", "letter.docx")


def test_a_200_with_a_real_pdf_is_returned_and_the_form_is_shaped_right(settings):
    settings.GOTENBERG_URL = "http://gotenberg:3000/"
    pdf = _one_page_pdf()
    with mock.patch("requests.post", return_value=_response(200, content=pdf)) as post:
        out, title = C.convert_from(data=b"docx bytes", filename="dir/letter.docx")
    assert out == pdf
    assert title == "letter"
    url, kwargs = post.call_args[0][0], post.call_args[1]
    assert url == "http://gotenberg:3000/forms/libreoffice/convert"
    field, (name, _stream, _ctype) = kwargs["files"][0]
    assert field == "files" and name == "letter.docx"


def test_an_html_file_is_always_posted_as_index_html():
    """Chromium renders the directory listing otherwise."""
    with mock.patch("requests.post",
                    return_value=_response(200, content=_one_page_pdf())) as post:
        C.convert_from(data=b"<p>hi</p>", filename="whatever.htm")
    url = post.call_args[0][0]
    _field, (name, _stream, _ctype) = post.call_args[1]["files"][0]
    assert url.endswith("/forms/chromium/convert/html")
    assert name == "index.html"


def test_a_url_is_checked_then_posted_as_a_form_field_and_titled_by_host():
    import ipaddress

    with mock.patch("apps.core.urlguard._resolve",
                    return_value=[ipaddress.ip_address("93.184.216.34")]), \
            mock.patch("requests.post",
                       return_value=_response(200, content=_one_page_pdf())) as post:
        _out, title = C.convert_from(url="https://user:pw@docs.example.com/report")
    assert title == "docs.example.com"
    assert post.call_args[1]["data"] == {"url": "https://user:pw@docs.example.com/report"}
    assert post.call_args[1]["files"] == []
    assert post.call_args[0][0].endswith("/forms/chromium/convert/url")


def test_the_url_title_never_carries_credentials_or_a_path():
    assert C._title_from_url("https://alice:s3cret@intranet.example.com:8443/x?y") \
        == "intranet.example.com"


def test_a_url_without_a_host_gets_a_generic_title():
    assert C._title_from_url("https:///nothing") == "Web page"


# --------------------------------------------------------------------------- #
# PDF → out, failure branches
# --------------------------------------------------------------------------- #
def test_a_pdf2docx_failure_is_a_conversion_failure(fixture_bytes):
    converter = mock.Mock()
    converter.convert.side_effect = RuntimeError("layout exploded")
    with mock.patch("pdf2docx.Converter", return_value=converter):
        with pytest.raises(EngineError) as caught:
            C.pdf_to_docx(fixture_bytes("text.pdf"))
    assert caught.value.code == "conversion_failed"
    assert "layout exploded" in str(caught.value)
    converter.close.assert_called_once()


def test_a_pdf2docx_run_that_writes_nothing_is_a_conversion_failure(fixture_bytes):
    def _write_nothing(dst):
        open(dst, "wb").close()

    converter = mock.Mock()
    converter.convert.side_effect = _write_nothing
    with mock.patch("pdf2docx.Converter", return_value=converter):
        with pytest.raises(EngineError, match="empty file"):
            C.pdf_to_docx(fixture_bytes("text.pdf"))


def test_a_markdown_failure_is_a_conversion_failure(fixture_bytes):
    with mock.patch("pymupdf4llm.to_markdown", side_effect=RuntimeError("no tables")):
        with pytest.raises(EngineError) as caught:
            C.pdf_to_markdown(fixture_bytes("text.pdf"))
    assert caught.value.code == "conversion_failed"
    assert "no tables" in str(caught.value)


def test_an_unknown_image_format_is_refused(fixture_bytes):
    with pytest.raises(InvalidParams, match="format"):
        C.pdf_to_images(fixture_bytes("text.pdf"), fmt="gif")


def test_jpeg_pages_are_written_as_jpeg(fixture_bytes):
    blob, name, _ = C.pdf_to_images(fixture_bytes("text.pdf"), fmt="jpeg", dpi=72)
    assert name == "pages-jpeg.zip"
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert archive.namelist()[0] == "page-0001.jpg"
        assert archive.read("page-0001.jpg")[:3] == b"\xff\xd8\xff"


def test_a_page_wider_than_the_format_allows_is_refused_before_rendering():
    doc = fitz.open()
    doc.new_page(width=C.MAX_RENDER_POINTS + 100, height=100)
    data = doc.tobytes()
    doc.close()
    with pytest.raises(InvalidParams, match="too large to render"):
        C.pdf_to_images(data, dpi=72)


def test_a_page_whose_pixmap_would_be_too_big_at_this_dpi_is_refused():
    doc = fitz.open()
    doc.new_page(width=10_000, height=10_000)  # 100 MP even at 72 dpi
    data = doc.tobytes()
    doc.close()
    with pytest.raises(InvalidParams, match="lower DPI"):
        C.pdf_to_images(data, dpi=72)


def test_body_of_slices_out_exactly_what_is_between_the_body_tags():
    html = "<html><head><title>t</title></head><body><p>one</p><p>two</p></body></html>"
    assert C._body_of(html) == "<p>one</p><p>two</p>"


def test_body_of_leaves_a_fragment_without_a_body_alone():
    assert C._body_of("<p>fragment</p>") == "<p>fragment</p>"


# --------------------------------------------------------------------------- #
# PDF/A, with OCRmyPDF patched
# --------------------------------------------------------------------------- #
def _pdfa_marked() -> bytes:
    doc = fitz.open()
    doc.new_page()
    doc.set_xml_metadata(
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">'
        "<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>"
        "</rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    try:
        return doc.tobytes()
    finally:
        doc.close()


def test_the_pdfa_marker_is_read_from_xmp_not_assumed():
    assert C.has_pdfa_marker(_pdfa_marked()) is True
    assert C.has_pdfa_marker(_one_page_pdf()) is False


def test_pdfa_conversion_returns_what_the_pipeline_wrote_and_reports_the_claim(fixture_bytes):
    marked = _pdfa_marked()

    def _fake_ocr(src, dst, **kwargs):
        assert kwargs["output_type"] == "pdfa" and kwargs["skip_text"] is True
        with open(dst, "wb") as fh:
            fh.write(marked)

    with mock.patch("ocrmypdf.ocr", side_effect=_fake_ocr):
        blob, name, ctype, report = C.convert_to(fixture_bytes("text.pdf"), target="pdfa")
    assert blob == marked
    assert (name, ctype) == ("document-pdfa.pdf", "application/pdf")
    assert report == {"claims_pdfa": True}


def test_a_pdfa_result_without_the_marker_is_reported_honestly(fixture_bytes):
    plain = _one_page_pdf()

    def _fake_ocr(src, dst, **kwargs):
        with open(dst, "wb") as fh:
            fh.write(plain)

    with mock.patch("ocrmypdf.ocr", side_effect=_fake_ocr):
        _blob, _name, _ctype, report = C.pdf_to_pdfa(fixture_bytes("text.pdf"))
    assert report == {"claims_pdfa": False}


def test_a_pdfa_pipeline_failure_is_a_conversion_failure(fixture_bytes):
    with mock.patch("ocrmypdf.ocr", side_effect=RuntimeError("ghostscript died")):
        with pytest.raises(EngineError) as caught:
            C.pdf_to_pdfa(fixture_bytes("text.pdf"))
    assert caught.value.code == "conversion_failed"
    assert "ghostscript died" in str(caught.value)


def test_a_pdfa_pipeline_that_writes_garbage_is_caught_by_the_probe(fixture_bytes):
    def _fake_ocr(src, dst, **kwargs):
        with open(dst, "wb") as fh:
            fh.write(b"%PDF-1.7 but not really")

    with mock.patch("ocrmypdf.ocr", side_effect=_fake_ocr):
        with pytest.raises(EngineError, match="PDF/A conversion"):
            C.pdf_to_pdfa(fixture_bytes("text.pdf"))


def test_convert_to_docx_dispatches_to_the_word_exporter(fixture_bytes):
    with mock.patch.object(C, "pdf_to_docx",
                           return_value=(b"PK", "document.docx", "application/x")) as docx:
        blob, name, ctype, report = C.convert_to(fixture_bytes("text.pdf"), target="docx")
    docx.assert_called_once()
    assert (blob, name, ctype, report) == (b"PK", "document.docx", "application/x", {})
