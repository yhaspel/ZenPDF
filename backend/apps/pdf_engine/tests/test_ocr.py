"""Golden tests for OCR (phase-06; §10, §18).

These run tesseract for real. They are the slowest tests in the suite and they
are worth it: OCR is the one operation whose output nothing else can predict,
and a mocked OCR test proves only that the mock was called.
"""
import time
import unicodedata

import fitz
import pytest

from apps.pdf_engine.engine import ocr as O
from apps.pdf_engine.exceptions import DocumentEncryptedError, EngineError, InvalidParams


def _text(data: bytes) -> str:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return unicodedata.normalize("NFKC", "\n".join(p.get_text() for p in doc))
    finally:
        doc.close()


def test_the_worker_image_ships_the_five_language_packs():
    """phase-06: eng+heb+deu+fra+spa. Hebrew is an acceptance criterion, not a
    nice-to-have — asked of **tesseract** rather than of our own constant.

    That distinction is the whole test. The previous version called
    `available_languages()`, which had silently been returning the constant
    since it was written, so it asserted the constant against itself.
    """
    from ocrmypdf.builtin_plugins.tesseract_ocr import TesseractOcrEngine

    installed = set(TesseractOcrEngine.languages(None))
    assert {"eng", "heb", "deu", "fra", "spa"} <= installed


def test_the_language_list_comes_from_tesseract_not_from_the_constant(monkeypatch):
    """A pack added with `OCR_EXTRA_LANGS` has to reach the answer.

    It never did: the build arg installed the pack and `_check_languages` then
    rejected it as "not installed", because the list it checked against was
    hard-coded.
    """
    from ocrmypdf.builtin_plugins.tesseract_ocr import TesseractOcrEngine

    monkeypatch.setattr(TesseractOcrEngine, "languages",
                        classmethod(lambda cls, *a: {"eng", "heb", "ara", "osd"}))
    languages = O.available_languages()
    assert "ara" in languages, languages
    # …and the five we ship stay in their declared order, with `osd` — which is
    # orientation detection, not a language — left out.
    assert languages[:2] == ["eng", "heb"]
    assert "osd" not in languages


def test_an_empty_tesseract_falls_back_rather_than_refusing_everything(monkeypatch):
    """A broken `TESSDATA_PREFIX` used to be invisible. Now it is visible —
    which means it must not turn into "no language is installed, including
    English", or OCR stops entirely for a deployment problem."""
    from ocrmypdf.builtin_plugins.tesseract_ocr import TesseractOcrEngine

    monkeypatch.setattr(TesseractOcrEngine, "languages",
                        classmethod(lambda cls, *a: set()))
    assert O.available_languages() == list(O.SUPPORTED_LANGUAGES)


def test_a_scan_becomes_selectable_text(fixture_bytes):
    scan = fixture_bytes("scanned.pdf")
    assert not O.has_text_layer(scan), "the fixture must start as pixels only"

    out, report = O.ocr(scan, languages=["eng"])
    assert report["has_text"] is True
    assert report["pages"] == 2
    text = _text(out)
    assert "Scanned page" in text
    assert "quick brown fox" in text


def test_ten_pages_finish_inside_the_budget(fixture_bytes):
    """Acceptance criterion: "OCR completes <60 s/10 pages"."""
    source = fitz.open(stream=fixture_bytes("scanned.pdf"), filetype="pdf")
    ten = fitz.open()
    try:
        while ten.page_count < 10:
            ten.insert_pdf(source)
        data = ten.tobytes()
    finally:
        ten.close()
        source.close()

    started = time.monotonic()
    out, report = O.ocr(data, languages=["eng"])
    elapsed = time.monotonic() - started
    assert report["pages"] == 10
    assert O.has_text_layer(out)
    assert elapsed < 60, f"10 pages took {elapsed:.1f}s"


def test_hebrew_is_recognised_and_comes_back_readable(fixture_bytes):
    """Acceptance criterion: "heb fixture produces RTL text correctly
    extractable". Asserted on the *letters*, not on an exact string: OCR of a
    rasterised page is a best effort, and demanding a perfect transcription
    would be testing tesseract's accuracy rather than our plumbing."""
    out, report = O.ocr(fixture_bytes("scanned-hebrew.pdf"), languages=["heb"])
    assert report["languages"] == ["heb"]
    text = _text(out)

    hebrew = [c for c in text if "֐" <= c <= "׿"]
    assert len(hebrew) >= 10, f"almost no Hebrew came back: {text!r}"
    # "שלום" — the one word big enough on the page to insist on.
    assert "שלום" in text or "שלוס" in text, text


def test_existing_text_is_left_alone_by_default(fixture_bytes):
    """`--skip-text` is the default for a reason: a born-digital PDF has a
    perfect text layer, and re-OCRing it replaces that with a guess at a
    picture of it."""
    born_digital = fixture_bytes("text.pdf")
    before = _text(born_digital)
    out, _ = O.ocr(born_digital, languages=["eng"])
    after = _text(out)
    assert "quick brown fox" in after
    assert before.split() == after.split(), "the original text layer was rewritten"


def test_force_re_ocrs_a_page_that_already_has_text(fixture_bytes):
    out, report = O.ocr(fixture_bytes("text.pdf"), languages=["eng"], force=True)
    assert report["forced"] is True
    assert O.has_text_layer(out)


def test_a_language_that_is_not_installed_says_which(fixture_bytes):
    with pytest.raises(InvalidParams) as exc:
        O.ocr(fixture_bytes("scanned.pdf"), languages=["klingon"])
    assert "klingon" in str(exc.value)
    assert "Available" in str(exc.value)


def test_an_encrypted_document_is_refused_in_words_the_user_can_act_on(fixture_bytes):
    with pytest.raises(DocumentEncryptedError, match="unlock"):
        O.ocr(fixture_bytes("encrypted.pdf"), languages=["eng"])


def test_a_broken_file_fails_as_an_engine_error_not_a_crash(fixture_bytes):
    with pytest.raises(EngineError):
        O.ocr(b"not a pdf at all", languages=["eng"])


def test_deskew_and_clean_are_accepted(fixture_bytes):
    """Both shell out to further tools (unpaper, Ghostscript); the point of the
    test is that the flags reach them and the pipeline still produces a PDF."""
    out, _ = O.ocr(fixture_bytes("scanned.pdf"), languages=["eng"],
                   deskew=True, clean=True)
    assert O.has_text_layer(out)
