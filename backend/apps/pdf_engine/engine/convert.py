"""Conversions in and out (phase-06; 01-architecture.md §10, §12 heavy queue).

Three different engines, chosen per format because each is the right tool once
and the wrong tool everywhere else:

* **Gotenberg** (a LibreOffice + Chromium service) for anything authored in an
  office suite or on the web. LibreOffice is deliberately not installed in our
  image — it is a large, network-facing attack surface, and keeping it in its
  own container is the whole reason that container exists.
* **PyMuPDF** for images in, and for images/text/HTML out — no external process,
  and the same library that renders every other page in the product.
* **pdf2docx / pymupdf4llm / OCRmyPDF** for the three formats that genuinely
  need a specialist: Word, Markdown and PDF/A.

Fidelity is honest rather than promised: `pdf_to_docx` reconstructs a layout
that never existed as a Word document, and the UI says so in those words.
"""
from __future__ import annotations

import io
import os
import tempfile
import zipfile

import fitz

from ..exceptions import EngineError, InvalidParams, UnsupportedFileError

# Anything LibreOffice opens. The list is the *offered* set, not everything
# Gotenberg would accept — an office format we have not tried is a support
# ticket waiting to happen.
OFFICE_EXTENSIONS = {
    "doc", "docx", "odt", "rtf", "txt",
    "xls", "xlsx", "ods", "csv",
    "ppt", "pptx", "odp",
}
IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "webp"}
HTML_EXTENSIONS = {"html", "htm"}

EXPORT_FORMATS = ("docx", "images", "txt", "md", "html", "pdfa")

# The largest page we will rasterise, in points. The PDF format allows 200 in
# (14 400 pt) and a hostile file can claim it: at 300 dpi that is 60 000 px per
# side, i.e. a multi-gigabyte pixmap allocated inside a worker. The image
# upload path refuses on header dimensions for exactly this reason (§17).
MAX_RENDER_POINTS = 14_400
MAX_RENDER_PIXELS = 80_000_000  # ~80 MP, comfortably above A0 at 300 dpi

A4 = fitz.paper_rect("a4")


def extension_of(filename: str) -> str:
    return (os.path.splitext(filename or "")[1] or "").lstrip(".").lower()


def kind_of(filename: str) -> str:
    """Which import route a file takes: office | image | html | pdf."""
    ext = extension_of(filename)
    if ext == "pdf":
        return "pdf"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in HTML_EXTENSIONS:
        return "html"
    if ext in OFFICE_EXTENSIONS:
        return "office"
    raise UnsupportedFileError(
        f"'{ext or filename}' is not a file type we can convert to PDF."
    )


# A modern office file is a zip, and LibreOffice will unpack whatever it is
# given. The first version of this guard read the central directory and did
# arithmetic on it — which is attacker-controlled metadata, and a ratio whose
# denominator is the upload size: two megabytes of incompressible padding took
# a 300 MB payload under both thresholds, and one such upload pinned Gotenberg
# at 1.4 GB until an operator restarted it.
#
# So this decompresses, with a budget. Streaming, entry by entry, stopping at
# the first byte over the cap — the cost of the check is bounded by the cap
# rather than by what the file claims (§10.1).
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
#: Read in chunks so a single huge entry cannot be materialised to measure it.
_ARCHIVE_CHUNK = 1024 * 1024


def check_archive(data: bytes, filename: str) -> None:
    """Refuse a zip-based upload that unpacks to more than we will convert."""
    if not zipfile.is_zipfile(io.BytesIO(data)):
        return  # .doc, .rtf, .txt, .csv — not a container
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            budget = MAX_ARCHIVE_UNCOMPRESSED_BYTES
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                # Never trust `entry.file_size`: it is metadata the uploader
                # wrote. The only honest measure is what comes out.
                with archive.open(entry) as stream:
                    while chunk := stream.read(min(_ARCHIVE_CHUNK, budget + 1)):
                        budget -= len(chunk)
                        if budget < 0:
                            raise UnsupportedFileError(
                                f"'{filename}' unpacks to more than "
                                f"{MAX_ARCHIVE_UNCOMPRESSED_BYTES // (1024 * 1024)}"
                                " MB, which is more than we will convert."
                            )
    except UnsupportedFileError:
        raise
    except (zipfile.BadZipFile, OSError, EOFError) as exc:
        raise UnsupportedFileError(
            f"'{filename}' is damaged and could not be opened."
        ) from exc


def check_renderable(page, zoom: float) -> None:
    """Refuse a page that would allocate an unreasonable pixmap.

    Rendering is the one place a hostile *document* (rather than a hostile
    request) can spend arbitrary memory: the page box is attacker-controlled and
    the pixmap is allocated before anything can measure it.
    """
    rect = page.rect
    if rect.width > MAX_RENDER_POINTS or rect.height > MAX_RENDER_POINTS:
        raise InvalidParams(
            f"Page {page.number + 1} is too large to render "
            f"({int(rect.width)}×{int(rect.height)} pt)."
        )
    pixels = (rect.width * zoom) * (rect.height * zoom)
    if pixels > MAX_RENDER_PIXELS:
        raise InvalidParams(
            f"Page {page.number + 1} is too large to render at this resolution. "
            "Try a lower DPI."
        )


def _probe(data: bytes, what: str) -> bytes:
    """Every conversion result is opened before it is handed back.

    A converter that exits 0 and writes a broken file is not a hypothetical:
    it is the normal failure mode of a pipeline with three processes in it, and
    the user finds out when the download will not open.
    """
    if not data:
        raise EngineError(f"{what} produced an empty file.", code="conversion_failed")
    try:
        doc = fitz.open(stream=data, filetype="pdf")
        try:
            # `filetype` is a *hint*: MuPDF sniffs the content and will happily
            # open a PNG or an HTML file as a one-page document. Without this,
            # a file named `photo.pdf` was stored verbatim under `docs/…v1.pdf`
            # and served as application/pdf — a "document" no reader can open.
            if not doc.is_pdf:
                raise EngineError(f"{what} did not produce a PDF.",
                                  code="conversion_failed")
            if doc.page_count < 1:
                raise EngineError(f"{what} produced a PDF with no pages.",
                                  code="conversion_failed")
        finally:
            doc.close()
    except EngineError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"{what} produced a file that is not a readable PDF: {exc}",
                          code="conversion_failed") from exc
    return data


# --------------------------------------------------------------------------- #
# In → PDF
# --------------------------------------------------------------------------- #
def images_to_pdf(images: list[bytes], *, fit: str = "a4") -> bytes:
    """One page per image — or per *frame*, so a multipage TIFF stays whole."""
    if fit not in {"a4", "original"}:
        raise InvalidParams("`fit` must be 'a4' or 'original'.")
    if not images:
        raise InvalidParams("No images to convert.")

    out = fitz.open()
    try:
        for blob in images:
            try:
                image = fitz.open(stream=blob)
                # An image document cannot be drawn onto a PDF page directly —
                # `show_pdf_page` refuses anything that is not a PDF. Converting
                # first also handles a multipage TIFF for free: every frame
                # becomes a page, so the loop below covers both cases.
                src = fitz.open("pdf", image.convert_to_pdf())
                image.close()
            except Exception as exc:  # noqa: BLE001
                raise UnsupportedFileError(f"That image could not be read: {exc}") from exc
            try:
                for page in src:
                    rect = page.rect
                    if fit == "a4":
                        target = A4
                        scale = min(target.width / rect.width, target.height / rect.height)
                        width, height = rect.width * scale, rect.height * scale
                        box = fitz.Rect(
                            (target.width - width) / 2, (target.height - height) / 2,
                            (target.width + width) / 2, (target.height + height) / 2,
                        )
                        new_page = out.new_page(width=target.width, height=target.height)
                    else:
                        box = fitz.Rect(0, 0, rect.width, rect.height)
                        new_page = out.new_page(width=rect.width, height=rect.height)
                    new_page.show_pdf_page(box, src, page.number)
            finally:
                src.close()
        if out.page_count < 1:
            raise UnsupportedFileError("No pages could be read from those images.")
        return out.tobytes(garbage=4, deflate=True)
    finally:
        out.close()


def _gotenberg(path: str, files: list[tuple[str, str, bytes]],
               data: dict | None = None, *, what: str) -> bytes:
    """POST a multipart form to Gotenberg and return the PDF it answers with."""
    import requests
    from django.conf import settings

    url = f"{settings.GOTENBERG_URL.rstrip('/')}{path}"
    payload = [
        (field, (name, io.BytesIO(blob), "application/octet-stream"))
        for field, name, blob in files
    ]
    try:
        response = requests.post(
            url, files=payload, data=data or {},
            timeout=getattr(settings, "GOTENBERG_TIMEOUT", 300),
        )
    except requests.Timeout as exc:
        raise EngineError(f"{what} took too long and was stopped.",
                          code="engine_timeout") from exc
    except requests.RequestException as exc:
        raise EngineError(f"{what} could not reach the converter: {exc}",
                          code="conversion_failed") from exc
    if response.status_code != 200:
        detail = (response.text or "")[:300].strip()
        raise EngineError(f"{what} failed: {detail or response.status_code}",
                          code="conversion_failed")
    return _probe(response.content, what)


def office_to_pdf(data: bytes, filename: str) -> bytes:
    return _gotenberg(
        "/forms/libreoffice/convert",
        [("files", os.path.basename(filename) or "document.docx", data)],
        what="Converting that document",
    )


def html_to_pdf(data: bytes, filename: str = "index.html") -> bytes:
    # Chromium needs the entry point to be called index.html whatever the user
    # called it, or it renders the directory listing instead of the page.
    return _gotenberg(
        "/forms/chromium/convert/html",
        [("files", "index.html", data)],
        what="Converting that page",
    )


def url_to_pdf(url: str) -> bytes:
    """Layer 1 of the SSRF guard runs here as well as at the API edge.

    Belt and braces on purpose: the API checks before a job exists so the user
    gets an immediate 400, and the worker checks again because a job's params
    are stored and could be replayed.
    """
    from apps.core.urlguard import check_url

    safe = check_url(url)
    return _gotenberg(
        "/forms/chromium/convert/url", [], {"url": safe},
        what="Converting that web page",
    )


def convert_from(*, data: bytes | None = None, filename: str = "",
                 url: str = "", images: list[bytes] | None = None,
                 fit: str = "a4") -> tuple[bytes, str]:
    """Anything → PDF. Returns (pdf bytes, a title for the new document)."""
    if url:
        return url_to_pdf(url), _title_from_url(url)
    if images:
        return images_to_pdf(images, fit=fit), "Images"
    if data is None:
        raise InvalidParams("Nothing to convert.")

    kind = kind_of(filename)
    stem = os.path.splitext(os.path.basename(filename or "document"))[0] or "Converted"
    if kind == "pdf":
        return _probe(data, "That file"), stem
    if kind == "image":
        return images_to_pdf([data], fit=fit), stem
    if kind == "html":
        return html_to_pdf(data, filename), stem
    return office_to_pdf(data, filename), stem


def _title_from_url(url: str) -> str:
    """The host, and only the host.

    `netloc` includes any `user:password@` prefix, which would then be the
    document's title — visible in the library, in listings and in logs.
    """
    from urllib.parse import urlsplit

    return (urlsplit(url).hostname or "Web page")[:200]


# --------------------------------------------------------------------------- #
# PDF → out
# --------------------------------------------------------------------------- #
def pdf_to_docx(data: bytes) -> tuple[bytes, str, str]:
    """Best-effort Word. The layout is *reconstructed*, not recovered — a PDF
    has no paragraphs, only positioned glyphs — and the UI says exactly that."""
    from pdf2docx import Converter

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.pdf")
        dst = os.path.join(tmp, "out.docx")
        with open(src, "wb") as fh:
            fh.write(data)
        converter = Converter(src)
        try:
            converter.convert(dst)
        except Exception as exc:  # noqa: BLE001
            raise EngineError(f"Converting to Word failed: {exc}",
                              code="conversion_failed") from exc
        finally:
            converter.close()
        with open(dst, "rb") as fh:
            out = fh.read()
    if not out:
        raise EngineError("Converting to Word produced an empty file.",
                          code="conversion_failed")
    return (out, "document.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")


def pdf_to_images(data: bytes, *, fmt: str = "png", dpi: int = 150) -> tuple[bytes, str, str]:
    """Every page as an image, zipped — one file is not a useful answer for a
    50-page document, and a zip is what every browser already knows how to do."""
    if fmt not in {"png", "jpg", "jpeg"}:
        raise InvalidParams("`format` must be 'png' or 'jpg'.")
    if not 72 <= int(dpi) <= 300:
        raise InvalidParams("`dpi` must be between 72 and 300.")

    extension = "jpg" if fmt in {"jpg", "jpeg"} else "png"
    zoom = int(dpi) / 72.0
    buf = io.BytesIO()
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
            for index in range(doc.page_count):
                check_renderable(doc[index], zoom)
                pix = doc[index].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                archive.writestr(f"page-{index + 1:04d}.{extension}",
                                 pix.tobytes(extension))
    finally:
        doc.close()
    return buf.getvalue(), f"pages-{fmt}.zip", "application/zip"


def pdf_to_text(data: bytes) -> tuple[bytes, str, str]:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        chunks = []
        for index in range(doc.page_count):
            chunks.append(f"--- Page {index + 1} ---\n{doc[index].get_text()}")
    finally:
        doc.close()
    return "\n".join(chunks).encode("utf-8"), "document.txt", "text/plain; charset=utf-8"


def pdf_to_markdown(data: bytes) -> tuple[bytes, str, str]:
    import pymupdf4llm

    doc = fitz.open(stream=data, filetype="pdf")
    try:
        text = pymupdf4llm.to_markdown(doc)
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"Converting to Markdown failed: {exc}",
                          code="conversion_failed") from exc
    finally:
        doc.close()
    return text.encode("utf-8"), "document.md", "text/markdown; charset=utf-8"


def pdf_to_html(data: bytes) -> tuple[bytes, str, str]:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        pages = [doc[i].get_text("html") for i in range(doc.page_count)]
    finally:
        doc.close()
    # Stitched rather than concatenated: PyMuPDF emits a whole document per
    # page, so pasting them together gives a file with N <html> elements.
    body = "\n<hr/>\n".join(_body_of(page) for page in pages)
    html = (
        "<!doctype html>\n<html><head><meta charset=\"utf-8\">"
        "<title>Converted document</title></head>\n"
        f"<body>\n{body}\n</body></html>\n"
    )
    return html.encode("utf-8"), "document.html", "text/html; charset=utf-8"


def _body_of(html: str) -> str:
    start = html.find("<body>")
    end = html.rfind("</body>")
    if start == -1 or end == -1:
        return html
    return html[start + len("<body>"):end]


def pdf_to_pdfa(data: bytes) -> tuple[bytes, str, str, dict]:
    """PDF/A-2b via OCRmyPDF, which drives Ghostscript for the conversion.

    Full veraPDF validation is backlog (phase-06 says so); what is asserted here
    is that the pipeline exited cleanly, the result opens, and it carries the
    `pdfaid` XMP marker that makes it *claim* conformance.
    """
    import ocrmypdf

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.pdf")
        dst = os.path.join(tmp, "out.pdf")
        with open(src, "wb") as fh:
            fh.write(data)
        try:
            ocrmypdf.ocr(src, dst, output_type="pdfa", skip_text=True,
                         progress_bar=False, jobs=1)
        except Exception as exc:  # noqa: BLE001
            raise EngineError(f"Converting to PDF/A failed: {exc}",
                              code="conversion_failed") from exc
        with open(dst, "rb") as fh:
            out = fh.read()

    _probe(out, "PDF/A conversion")
    return out, "document-pdfa.pdf", "application/pdf", {"claims_pdfa": has_pdfa_marker(out)}


def has_pdfa_marker(data: bytes) -> bool:
    """Does the file carry the XMP `pdfaid` part/conformance marker?"""
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        xmp = doc.get_xml_metadata() or ""
    finally:
        doc.close()
    return "pdfaid" in xmp


def convert_to(data: bytes, *, target: str, dpi: int = 150,
               image_format: str = "png") -> tuple[bytes, str, str, dict]:
    """PDF → one of the six export formats. Returns (bytes, filename, type, report)."""
    if target not in EXPORT_FORMATS:
        raise InvalidParams(f"`format` must be one of {list(EXPORT_FORMATS)}.")
    if target == "docx":
        blob, name, ctype = pdf_to_docx(data)
    elif target == "images":
        blob, name, ctype = pdf_to_images(data, fmt=image_format, dpi=dpi)
    elif target == "txt":
        blob, name, ctype = pdf_to_text(data)
    elif target == "md":
        blob, name, ctype = pdf_to_markdown(data)
    elif target == "html":
        blob, name, ctype = pdf_to_html(data)
    else:
        blob, name, ctype, report = pdf_to_pdfa(data)
        return blob, name, ctype, report
    return blob, name, ctype, {}
