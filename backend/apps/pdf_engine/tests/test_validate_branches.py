"""Cover the validate.py recovery branches that no real fixture can trigger."""
import fitz
import pikepdf
import pytest

from apps.pdf_engine.engine import validate as V
from apps.pdf_engine.exceptions import UnsupportedFileError


def test_pikepdf_fails_but_fitz_recovers(fixture_bytes, monkeypatch):
    def boom(*a, **k):
        raise pikepdf.PdfError("qpdf gave up")

    monkeypatch.setattr(pikepdf, "open", boom)
    result = V.validate_pdf(fixture_bytes("text.pdf"))  # fitz still opens it
    assert result["needs_repair"] is True


def test_both_engines_fail_is_unsupported(monkeypatch):
    def boom_pike(*a, **k):
        raise pikepdf.PdfError("no")

    def boom_fitz(*a, **k):
        raise RuntimeError("no")

    monkeypatch.setattr(pikepdf, "open", boom_pike)
    monkeypatch.setattr(fitz, "open", boom_fitz)
    with pytest.raises(UnsupportedFileError):
        V.validate_pdf(b"%PDF-1.4 not really")
