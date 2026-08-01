#!/usr/bin/env python
"""Generate the golden test PDF corpus (01-architecture.md §18).

Run inside the api/worker image (needs fitz + pikepdf):
    python tests/fixtures/generate_fixtures.py

Produces, under tests/fixtures/pdfs/:
    text.pdf, unicode.pdf, form.pdf, scanned.pdf, encrypted.pdf,
    rotated-90.pdf, corrupt.pdf, large-generated.pdf, hebrew-rtl.pdf,
    xfa-form.pdf

Committed to the repo so tests don't regenerate; re-run to refresh.
"""
import io
import os

import fitz
import pikepdf

OUT = os.path.join(os.path.dirname(__file__), "pdfs")
os.makedirs(OUT, exist_ok=True)


def _text_doc(pages: int, prefix: str) -> fitz.Document:
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 100), f"{prefix} — page {i + 1}", fontsize=22)
        page.insert_text((72, 140), f"ZenPDF golden fixture. Invoice number 2026-000{i + 1}",
                         fontsize=12)
        page.insert_text((72, 170), "The quick brown fox jumps over the lazy dog.", fontsize=12)
    return doc


def make_text():
    doc = _text_doc(3, "Sample document")
    doc.save(os.path.join(OUT, "text.pdf"))
    doc.close()


def make_unicode():
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "Café résumé — naïve coöperate façade", fontsize=18)
    page.insert_text((72, 140), "Ångström Ω ∑ ≈ ½ © €", fontsize=16)
    try:
        page.insert_text((72, 180), "你好世界 こんにちは 안녕하세요", fontsize=18, fontname="china-ss")
    except Exception:  # noqa: BLE001
        pass
    doc.save(os.path.join(OUT, "unicode.pdf"))
    doc.close()


def make_form():
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 80), "Job application", fontsize=20)

    text_widget = fitz.Widget()
    text_widget.field_name = "full_name"
    text_widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    text_widget.rect = fitz.Rect(72, 120, 400, 145)
    text_widget.field_value = ""
    page.add_widget(text_widget)

    check = fitz.Widget()
    check.field_name = "agree"
    check.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
    check.rect = fitz.Rect(72, 160, 92, 180)
    check.field_value = False
    page.add_widget(check)

    doc.save(os.path.join(OUT, "form.pdf"))
    doc.close()


def make_scanned():
    """Image-only pages (no text layer) — for OCR + compress fixtures."""
    src = _text_doc(2, "Scanned page")
    out = fitz.open()
    for i in range(src.page_count):
        pix = src[i].get_pixmap(matrix=fitz.Matrix(2.5, 2.5))  # ~180 dpi, sizable
        page = out.new_page(width=src[i].rect.width, height=src[i].rect.height)
        page.insert_image(page.rect, pixmap=pix)
    out.save(os.path.join(OUT, "scanned.pdf"), deflate=True)
    out.close()
    src.close()


def make_rotated():
    doc = fitz.open()
    for i in range(2):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 120), f"Rotated fixture page {i + 1}", fontsize=18)
        page.set_rotation(90)
    doc.save(os.path.join(OUT, "rotated-90.pdf"))
    doc.close()


def make_large():
    doc = fitz.open()
    for i in range(500):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 100), f"Large document page {i + 1} of 500", fontsize=16)
    doc.save(os.path.join(OUT, "large-generated.pdf"), deflate=True)
    doc.close()


def make_encrypted():
    doc = _text_doc(2, "Confidential")
    raw = doc.tobytes()
    doc.close()
    pdf = pikepdf.open(io.BytesIO(raw))
    enc = pikepdf.Encryption(owner="owner-secret", user="secret", R=6)
    pdf.save(os.path.join(OUT, "encrypted.pdf"), encryption=enc)
    pdf.close()


def make_hebrew():
    """RTL fixture (phase-03 risk: 'text-layer selection quality on odd PDFs').

    `insert_htmlbox` is used rather than `insert_text` because it is the only
    route that applies bidi reordering — with `insert_text` the glyphs land in
    logical order, which is not what a reader sees and would make any quads test
    assert the wrong thing. Owner locale is Hebrew, so this is a real case.
    """
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_htmlbox(
        fitz.Rect(60, 60, 535, 200),
        '<div dir="rtl" style="font-size:22px">שלום עולם — מסמך בדיקה</div>',
    )
    page.insert_htmlbox(
        fitz.Rect(60, 220, 535, 340),
        '<div dir="rtl" style="font-size:14px">'
        "זהו קובץ בדיקה של ZenPDF עבור הערות והדגשות בעברית."
        "</div>",
    )
    # A mixed-direction line: numbers and Latin inside RTL text are where naive
    # quad math goes wrong.
    page.insert_htmlbox(
        fitz.Rect(60, 360, 535, 460),
        '<div dir="rtl" style="font-size:14px">חשבונית מספר 2026-0007 בסך 1,250 ש"ח</div>',
    )
    doc.save(os.path.join(OUT, "hebrew-rtl.pdf"))
    doc.close()


def make_xfa():
    """An XFA form (phase-05 corpus addition).

    XFA describes the form in an XML payload that readers other than Acrobat
    largely ignore, with the AcroForm fields beside it as a partial fallback.
    Built by hand rather than taken from a public sample so the fixture is
    small, license-free and minimal — what matters for the test is the `/XFA`
    key the detector looks for, plus a real AcroForm field so "degrades
    gracefully" means something.
    """
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 80), "XFA sample form", fontsize=18)
    widget = fitz.Widget()
    widget.field_name = "legacy_name"
    widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    widget.rect = fitz.Rect(72, 120, 400, 145)
    widget.field_value = ""
    page.add_widget(widget)
    raw = doc.tobytes()
    doc.close()

    pdf = pikepdf.open(io.BytesIO(raw))
    xml = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'
        b'<template xmlns="http://www.xfa.org/schema/xfa-template/3.0/">'
        b'<subform name="form1"><field name="legacy_name"/></subform>'
        b"</template></xdp:xdp>"
    )
    pdf.Root.AcroForm.XFA = pikepdf.Array([
        pikepdf.String("xdp"), pdf.make_stream(xml),
    ])
    pdf.save(os.path.join(OUT, "xfa-form.pdf"))
    pdf.close()


def make_corrupt():
    """Valid PDF with its trailer/xref chopped off: pikepdf rejects, fitz repairs."""
    doc = _text_doc(1, "Corrupt fixture")
    raw = doc.tobytes()
    doc.close()
    truncated = raw[: int(len(raw) * 0.82)]  # drop xref + trailer
    with open(os.path.join(OUT, "corrupt.pdf"), "wb") as fh:
        fh.write(truncated)


if __name__ == "__main__":
    make_text()
    make_unicode()
    make_form()
    make_scanned()
    make_rotated()
    make_large()
    make_encrypted()
    make_hebrew()
    make_xfa()
    make_corrupt()
    print("Fixtures written to", OUT)
    for name in sorted(os.listdir(OUT)):
        if name.endswith(".pdf"):
            size = os.path.getsize(os.path.join(OUT, name))
            print(f"  {name:24} {size:>9} bytes")
