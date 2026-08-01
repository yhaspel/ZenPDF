"""OCR (phase-06; 01-architecture.md §10, §12 heavy queue).

OCRmyPDF wraps tesseract and Ghostscript and does the part that matters: it
leaves the page image alone and adds an *invisible* text layer over it, so the
document still looks like the scan it is while becoming searchable, selectable
and — the reason Phase 4 cares — editable.

Run in-process rather than by shelling out to the CLI: the Python API surfaces
its exception taxonomy, which is what lets a failure become a sentence the user
can act on instead of "exit status 2".
"""
from __future__ import annotations

import os
import tempfile

import fitz

from ..exceptions import DocumentEncryptedError, EngineError, InvalidParams

# Shipped in the worker image (phase-06). Hebrew is there because the owner's
# own documents are RTL, and it is an acceptance criterion.
SUPPORTED_LANGUAGES = ("eng", "heb", "deu", "fra", "spa")


def available_languages() -> list[str]:
    """What tesseract actually has installed, for the UI's language picker.

    Asked of the binary rather than assumed from the list above: the image can
    be built with `OCR_EXTRA_LANGS`, and a picker offering a language that
    fails at run time is worse than one that is short.
    """
    try:
        from ocrmypdf import get_ocr_engine

        installed = set(get_ocr_engine().languages())
    except Exception:  # noqa: BLE001 — no tesseract is a deployment problem, not a request one
        return list(SUPPORTED_LANGUAGES)
    ordered = [lang for lang in SUPPORTED_LANGUAGES if lang in installed]
    return ordered + sorted(installed - set(SUPPORTED_LANGUAGES) - {"osd"})


def _check_languages(languages) -> list[str]:
    if not languages:
        return ["eng"]
    if not isinstance(languages, (list, tuple)):
        raise InvalidParams("`languages` must be a list.")
    installed = set(available_languages())
    chosen = [str(lang).strip() for lang in languages if str(lang).strip()]
    missing = [lang for lang in chosen if lang not in installed]
    if missing:
        raise InvalidParams(
            f"Language pack(s) not installed: {', '.join(missing)}. "
            f"Available: {', '.join(sorted(installed))}."
        )
    return chosen or ["eng"]


def page_count(data: bytes) -> int:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return doc.page_count
    finally:
        doc.close()


def has_text_layer(data: bytes) -> bool:
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        return any(page.get_text().strip() for page in doc)
    finally:
        doc.close()


def ocr(data: bytes, *, languages=None, deskew: bool = False,
        rotate_pages: bool = False, clean: bool = False,
        force: bool = False) -> tuple[bytes, dict]:
    """Add a text layer. Returns (pdf bytes, report).

    `force` re-OCRs pages that already have text — off by default, because the
    default `--skip-text` is what stops a born-digital PDF having its real,
    perfect text layer replaced by a guess at a picture of it.
    """
    import ocrmypdf
    from ocrmypdf.exceptions import (
        EncryptedPdfError,
        PriorOcrFoundError,
        TaggedPDFError,
        UnsupportedImageFormatError,
    )

    chosen = _check_languages(languages)
    pages = page_count(data)

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.pdf")
        dst = os.path.join(tmp, "out.pdf")
        with open(src, "wb") as fh:
            fh.write(data)

        options = {
            "language": chosen,
            "deskew": bool(deskew),
            "rotate_pages": bool(rotate_pages),
            "clean": bool(clean),
            "progress_bar": False,
            # One worker process per job: the heavy queue already runs jobs in
            # parallel, and letting each one fan out over every core turns two
            # concurrent OCRs into a machine that serves neither.
            "jobs": 1,
        }
        if force:
            options["force_ocr"] = True
        else:
            options["skip_text"] = True

        try:
            ocrmypdf.ocr(src, dst, **options)
        except EncryptedPdfError as exc:
            raise DocumentEncryptedError(
                "This document is encrypted; unlock it before running OCR."
            ) from exc
        except PriorOcrFoundError as exc:
            raise EngineError(
                "This document already has a text layer. Tick "
                "“Redo OCR” to replace it.", code="already_ocred",
            ) from exc
        except TaggedPDFError as exc:
            # Not fatal upstream either — a tagged PDF already has structure, so
            # OCR would fight it. Say so rather than producing a worse file.
            raise EngineError(
                "This document is already tagged as accessible text, so OCR "
                "would not improve it.", code="tagged_pdf",
            ) from exc
        except UnsupportedImageFormatError as exc:
            raise EngineError(
                f"One of the page images could not be read: {exc}",
                code="ocr_engine_error",
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise EngineError(f"OCR failed: {exc}", code="ocr_engine_error") from exc

        with open(dst, "rb") as fh:
            out = fh.read()

    return out, {
        "pages": pages,
        "languages": chosen,
        "forced": bool(force),
        "has_text": has_text_layer(out),
    }
