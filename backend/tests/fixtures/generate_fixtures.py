#!/usr/bin/env python
"""Generate the golden test PDF corpus (01-architecture.md §18).

Run inside the api/worker image (needs fitz + pikepdf):
    python tests/fixtures/generate_fixtures.py

Produces, under tests/fixtures/pdfs/:
    text.pdf, unicode.pdf, form.pdf, form-multi.pdf, scanned.pdf,
    scanned-hebrew.pdf, compare-a.pdf, compare-b.pdf, encrypted.pdf,
    rotated-90.pdf, corrupt.pdf, large-generated.pdf, hebrew-rtl.pdf,
    xfa-form.pdf

Committed to the repo so tests don't regenerate; re-run to refresh.
"""
import io
import os

import fitz
import pikepdf

OUT = os.path.join(os.path.dirname(__file__), "pdfs")
IMAGES = os.path.join(os.path.dirname(__file__), "images")
os.makedirs(OUT, exist_ok=True)
os.makedirs(IMAGES, exist_ok=True)


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


def make_multi_form():
    """A form with more than one field type, for the fill-mode E2E.

    `form.pdf` stays the minimal two-field case most unit tests assert against;
    this one carries a text box, a checkbox, a drop-down and a list, so the
    browser path can be driven across four kinds of widget.
    """
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 80), "Conference registration", fontsize=20)

    def field(name, kind, y, height=25, **extra):
        widget = fitz.Widget()
        widget.field_name = name
        widget.field_type = kind
        widget.rect = fitz.Rect(180, y, 400, y + height)
        for key, value in extra.items():
            setattr(widget, key, value)
        page.insert_text((72, y + 16), name.capitalize(), fontsize=11)
        page.add_widget(widget)

    field("attendee", fitz.PDF_WIDGET_TYPE_TEXT, 120, field_value="")
    field("vegetarian", fitz.PDF_WIDGET_TYPE_CHECKBOX, 165, height=20, field_value=False)
    field("ticket", fitz.PDF_WIDGET_TYPE_COMBOBOX, 205,
          choice_values=["standard", "student", "speaker"], field_value="standard")
    field("track", fitz.PDF_WIDGET_TYPE_LISTBOX, 245,
          choice_values=["backend", "frontend", "design"], field_value="backend")

    doc.save(os.path.join(OUT, "form-multi.pdf"))
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


def make_scanned_hebrew():
    """An image-only page of Hebrew — the phase-06 OCR acceptance criterion.

    Rendered from `insert_htmlbox` rather than `insert_text` because only the
    former applies bidi reordering, so the pixels are in the order a reader
    sees them, which is what tesseract has to cope with. Rasterised at ~300 dpi:
    Hebrew is harder to recognise than Latin and 180 dpi is marginal.
    """
    src = fitz.open()
    page = src.new_page(width=595, height=842)
    page.insert_htmlbox(
        fitz.Rect(60, 60, 535, 200),
        '<div dir="rtl" style="font-size:30px">שלום עולם</div>',
    )
    page.insert_htmlbox(
        fitz.Rect(60, 220, 535, 360),
        '<div dir="rtl" style="font-size:26px">מסמך סרוק לבדיקה</div>',
    )
    out = fitz.open()
    pix = src[0].get_pixmap(matrix=fitz.Matrix(4.2, 4.2))
    dest = out.new_page(width=src[0].rect.width, height=src[0].rect.height)
    dest.insert_image(dest.rect, pixmap=pix)
    out.save(os.path.join(OUT, "scanned-hebrew.pdf"), deflate=True)
    out.close()
    src.close()


def make_sample_image():
    """A PNG for the image-import path (phase-06) — the one fixture in the
    corpus that is deliberately *not* a PDF."""
    doc = fitz.open()
    page = doc.new_page(width=400, height=260)
    page.draw_rect(page.rect, color=None, fill=(0.96, 0.97, 1.0))
    page.insert_text((30, 90), "ZenPDF sample image", fontsize=22)
    page.insert_text((30, 130), "for the image-to-PDF route", fontsize=13)
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
    doc.close()
    pix.save(os.path.join(IMAGES, "sample.png"))


def make_compare_pair():
    """Two nearly-identical documents, for compare (phase-06 §Tests).

    One word changed, one paragraph added, and a black box stamped on page 2 —
    a text-only change, a structural change, and a change the text diff cannot
    see, which is the whole reason the visual pass exists.
    """
    for name, changed in (("compare-a.pdf", False), ("compare-b.pdf", True)):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 100), "Quarterly report", fontsize=22)
        page.insert_text((72, 140),
                         "Revenue grew by twelve percent this quarter.",
                         fontsize=12)
        if changed:
            page.insert_text((72, 170), "An extra line only B has.", fontsize=12)
        second = doc.new_page(width=595, height=842)
        second.insert_text((72, 100), "Appendix", fontsize=22)
        second.insert_text((72, 140), "The figures above are unaudited.", fontsize=12)
        if changed:
            # Visible to a pixel comparison, invisible to a text diff.
            second.draw_rect(fitz.Rect(200, 300, 420, 420), color=None, fill=(0, 0, 0))
        doc.save(os.path.join(OUT, name))
        doc.close()


def make_pii():
    """A page of the things pattern redaction is meant to catch — and of the
    near-misses it must leave alone (phase-07)."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 80), "Client record", fontsize=20)
    lines = [
        # Three emails, deliberately: the review list is only worth having if a
        # user can keep some matches and drop others, and two is not enough to
        # show that (phase-07 E2E: "review shows 3, uncheck 1, apply 2").
        "Email: dana.cohen@example.com",
        "Second email: r.levi@mail.example.co.uk",
        "Copy to: sam.parker@example.org",
        "Social security number: 123-45-6789",
        "Telephone: +44 20 7946 0958",
        "Card on file: 4111 1111 1111 1111",
        "IBAN: GB33BUKB20201555555555",
        "",
        "Not secrets, and must survive:",
        "Invoice 2026-000-1234 dated 2026-08-02",
        "Reference 999-99-9999-XYZ",
        "Order number 1234 5678 9012 3456 7",
    ]
    for i, line in enumerate(lines):
        page.insert_text((60, 130 + i * 26), line, fontsize=12)
    doc.save(os.path.join(OUT, "pii.pdf"))
    doc.close()


def make_redact_image():
    """A page whose picture must be destroyed, not covered (phase-07)."""
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    photo = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 200, 150))
    photo.set_rect(photo.irect, (220, 40, 40))
    page.insert_image(fitz.Rect(60, 60, 340, 260), pixmap=photo)
    page.insert_text((60, 40), "Photo below", fontsize=14)
    doc.save(os.path.join(OUT, "redact-image.pdf"))
    doc.close()


def make_booby_trapped():
    """Everything `sanitize` is supposed to find: document JavaScript, an
    OpenAction, an embedded file, metadata, XMP, an outbound link — and a layer
    that is switched *off*, carrying text the reader never sees."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 100), "Looks like an ordinary invoice", fontsize=16)
    # An optional-content group, default OFF: the classic "redacted" document
    # that still contains what was supposedly taken out.
    hidden = doc.add_ocg("Draft notes", on=False)
    page.insert_text((60, 160), "HIDDENLAYERSECRET", fontsize=14, oc=hidden)
    page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(60, 120, 300, 140),
                      "uri": "https://tracker.example.com/beacon"})
    doc.set_metadata({"title": "Quarterly", "author": "Dana Cohen",
                      "subject": "internal", "keywords": "confidential"})
    doc.embfile_add("payload.txt", b"attached secret", filename="payload.txt")
    raw = doc.tobytes()
    doc.close()

    pdf = pikepdf.open(io.BytesIO(raw))
    js = pdf.make_indirect(pikepdf.Dictionary(
        S=pikepdf.Name.JavaScript, JS=pikepdf.String("app.alert('hello');"),
    ))
    pdf.Root.OpenAction = js
    names = pdf.Root.get("/Names") or pdf.make_indirect(pikepdf.Dictionary())
    names["/JavaScript"] = pdf.make_indirect(pikepdf.Dictionary(
        Names=pikepdf.Array([pikepdf.String("boot"), js]),
    ))
    pdf.Root.Names = names
    with pdf.open_metadata() as meta:
        meta["dc:title"] = "Quarterly"
    pdf.save(os.path.join(OUT, "booby-trapped.pdf"))
    pdf.close()


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
    make_multi_form()
    make_scanned()
    make_scanned_hebrew()
    make_compare_pair()
    make_sample_image()
    make_pii()
    make_redact_image()
    make_booby_trapped()
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
