"""Upload validation + repair (phase 1 ingest, §17).

`validate_pdf` is the bounded in-request probe (§3): magic bytes → pikepdf parse
→ encryption + page/metadata via PyMuPDF. `repair_pdf` normalizes a broken file
via PyMuPDF (auto-repairs on open) — the basic P6 repair path usable now.
"""
from __future__ import annotations

import io

from ..exceptions import DocumentEncryptedError, UnsupportedFileError
from .inspect import inspect


def _trailer_is_damaged(data: bytes) -> bool:
    """A well-formed PDF ends with `startxref <offset> %%EOF`.

    qpdf/mupdf both silently *reconstruct* a file whose cross-reference table or
    trailer is broken, so `pikepdf.open` succeeding does not mean the file is
    clean. A missing terminator in the tail is the reliable signal that the
    xref/trailer was damaged and the parser had to rebuild it.
    """
    tail = data[-2048:]
    return b"%%EOF" not in tail or b"startxref" not in tail


def validate_pdf(data: bytes) -> dict:
    """Return {encrypted, needs_repair, pages, size, metadata, toc}.

    - Not a PDF at all → UnsupportedFileError (no repair offer).
    - pikepdf can't parse but PyMuPDF can → needs_repair=True.
    - Opens but its trailer/xref was reconstructed (damaged) → needs_repair=True.
    - Encrypted → encrypted=True (stored locked; §17).
    """
    import pikepdf

    if b"%PDF-" not in data[:1024]:
        raise UnsupportedFileError("Not a PDF (missing %PDF header).")

    encrypted = False
    needs_repair = False
    try:
        with pikepdf.open(io.BytesIO(data)):
            pass
    except pikepdf.PasswordError:
        encrypted = True
    except pikepdf.PdfError as exc:
        # qpdf gave up. Can PyMuPDF still read it? If so it is repairable.
        import fitz

        try:
            probe = fitz.open(stream=data, filetype="pdf")
            _ = probe.page_count
            probe.close()
            needs_repair = True
        except Exception:  # noqa: BLE001
            raise UnsupportedFileError("This file could not be read as a PDF.") from exc

    if not encrypted and not needs_repair and _trailer_is_damaged(data):
        needs_repair = True

    pages, size, metadata, toc = 0, len(data), {}, []
    if not encrypted:
        info = inspect(data)
        encrypted = info["encrypted"] or info["needs_password"]
        pages = info["pages"]
        metadata = info["metadata"]
        toc = info["toc"]

    return {
        "encrypted": encrypted,
        "needs_repair": needs_repair,
        "pages": pages,
        "size": size,
        "metadata": metadata,
        "toc": toc,
    }


def repair_pdf(data: bytes) -> bytes:
    """Repair/normalize a broken PDF via PyMuPDF (opens with auto-repair, re-saves)."""
    import fitz

    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise UnsupportedFileError(f"File is too damaged to repair: {exc}") from exc
    try:
        if doc.needs_pass:
            raise DocumentEncryptedError("Cannot repair an encrypted document.")
        return doc.tobytes(garbage=4, deflate=True, clean=True)
    finally:
        doc.close()
