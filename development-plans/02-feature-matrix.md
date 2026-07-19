# 02 — Feature Matrix (research taxonomy → plan mapping)

Every feature surfaced in research (00-research-findings.md) is mapped below. Status: **P#** = planned in that phase · **BL** = backlog (post-v1, consciously deferred) · **OUT** = out of scope (with reason). This table is the completeness proof for the plan.

## Viewing & navigation

| Feature | Status | Notes |
|---|---|---|
| Render/zoom/fit/print | P1 | ngx-extended-pdf-viewer |
| Text selection + in-document search | P1 | PDF.js text layer |
| Page thumbnails rail | P1 | server-rendered PNGs (drag-drop added in P2) |
| Bookmarks/outline view | P1 | read; editing in P4 (`set_bookmarks`) |
| Metadata viewer | P1 | editing in P4 |
| Version history browser | P1 | ZenPDF-specific (undo model) |
| Attachments panel, layers (OCG), 3D, measure tools | OUT | niche desktop-tier; no product need |

## Page organization

| Feature | Status |
|---|---|
| Merge | P2 |
| Split: ranges / every N / by size / by bookmarks | P2 |
| Reorder (drag-drop) | P2 |
| Rotate / delete / duplicate | P2 |
| Extract (to new doc or download) | P2 |
| Insert blank / from another PDF | P2 |
| Crop | P2 |
| Scale/resize pages | P2 |
| N-up (2/4-up) | P2 |
| Alternate-mix (interleave scans) | P2 |
| Compress/optimize (presets + DPI) | P2 |
| Overlay/background PDF | P4 (`overlay_pdf`) |
| Booklet imposition | BL |
| Remove blank pages (auto-detect) | BL |

## Content editing

| Feature | Status | Notes |
|---|---|---|
| Edit existing text | P4 | server-side redact+reinsert (PyMuPDF); fidelity caveats + scanned-page gate (OCR first) |
| Add text boxes | P4 | |
| Whiteout | P4 | |
| Find & replace | P4 | |
| Add/replace/delete images | P4 | |
| Add/edit/remove links | P4 | |
| Headers & footers / page numbers | P4 | |
| Watermark (text/image) | P4 | |
| Bates numbering | P4 | differentiator (Acrobat/PXC/Sejda-class) |
| Metadata + bookmark editing | P4 | |
| Spell-check | OUT | browser-native spellcheck in inputs suffices |
| Paragraph-level reflow across lines | BL | v1 edits are block-scoped (honest constraint of engine) |

## Annotation & markup

| Feature | Status | Notes |
|---|---|---|
| Highlight/underline/strikethrough/squiggly (text-anchored) | P3 | |
| Sticky notes + comments sidebar | P3 | |
| Free text | P3 | |
| Shapes: rect/ellipse/line/arrow/polygon | P3 | |
| Freehand ink | P3 | |
| Stamps: standard set + custom image | P3 | |
| Flatten annotations | P3 | |
| Batch-remove annotations | P3 | |
| Threaded comment replies | BL | single-level notes in v1 |
| Audio comments, callout connectors | OUT | niche |

## Forms

| Feature | Status | Notes |
|---|---|---|
| Fill AcroForms in-browser + save | P5 | |
| Create/edit/delete fields (text, checkbox, radio, dropdown, listbox; signature placeholders via pyHanko) | P5 | |
| Required/default/format properties | P5 | basic validation, no JS logic |
| Import/export form data (JSON/CSV) | P5 | FDF: BL |
| Flatten form | P5 | |
| Auto field detection, XFA, JS field logic, web-form distribution | OUT | Acrobat-legacy/proprietary tier |

## Scan & OCR / Conversion

| Feature | Status | Notes |
|---|---|---|
| OCR → searchable PDF (multi-language, deskew/rotate/clean) | P6 | OCRmyPDF |
| Office (docx/xlsx/pptx) → PDF | P6 | Gotenberg/LibreOffice |
| Images → PDF | P6 | PyMuPDF |
| HTML/URL → PDF | P6 | Gotenberg/Chromium + SSRF guards |
| PDF → Word (docx) | P6 | pdf2docx |
| PDF → images / text / Markdown / HTML | P6 | PyMuPDF + pymupdf4llm |
| PDF/A export | P6 | OCRmyPDF `--output-type pdfa` |
| Repair corrupted PDF | P6 | pikepdf (also auto-offered at upload, P1) |
| Compare documents (text diff + visual) | P6 | differentiator; only iLovePDF has it among web suites |
| PDF → Excel/PPT | BL | poor OSS fidelity; camelot-based table extraction as BL |
| Email → PDF, EPUB, CAD/InDesign export | OUT | niche |

## Security

| Feature | Status | Notes |
|---|---|---|
| Password protect (AES-256, open+owner) | P7 | pikepdf |
| Remove password / change permissions | P7 | |
| Permission flags (print/copy/modify) | P7 | |
| True redaction: draw areas | P7 | PyMuPDF apply_redactions |
| Redaction by search: text/regex + presets (SSN, email, phone) | P7 | |
| Image-content redaction | P7 | |
| Sanitize (metadata, JS, attachments, hidden content) | P7 | |
| Open encrypted docs (password prompt) | P1 | 423 flow |
| AI-powered PII detection | OUT | AI scope removed by owner |

## E-signature

| Feature | Status | Notes |
|---|---|---|
| Saved signatures/initials: draw, type (fonts), upload | P8 | signature_pad |
| Self-sign (place + flatten) | P8 | |
| Sign requests: multi-recipient, roles (signer/approver/viewer/CC) | P8 | Documenso-class role model |
| Sequential/parallel/mixed routing | P8 | order ints |
| Field placement per recipient (signature/initials/date/text/checkbox) | P8 | |
| Public tokenized signing ceremony (no account) | P8 | |
| ESIGN/UETA compliance: intent, consent disclosure + logging, association, retention | P8 | |
| Decline with reason / cancel / resend | P8 | |
| Auto-reminders + expiration | P8 | beat |
| Audit trail (IP, UA, UTC events, hash chain) + certificate of completion PDF | P8 | |
| Tamper-evident PAdES seal with platform certificate (B-B/B-T; B-LT with real cert+TSA) | P8 | pyHanko |
| Signature verification tool (upload → validity report) | P8 | `/verify` |
| Envelope code stamped on pages | P8 | |
| Templates, bulk send, in-person mode, reassign, ID verification (SMS/KBA), QES/AES | BL | commercial-tier; explicit backlog |

## Platform, monetization & cross-cutting

| Feature | Status | Notes |
|---|---|---|
| Multi-user accounts (JWT), private workspace | P0/P1 | |
| Folders, starring, trash (30-day), search library | P1 | |
| Async job engine + progress UI | P0/P1 | |
| Quotas & anti-abuse throttles | P1 baseline, P9 tightened | |
| Ad slots + consent management (CMP) + ads.txt + privacy/terms | P9 | revenue model |
| Public landing page (SEO) | P0 shell, P9 polished | |
| Usage dashboard (`/api/users/me/usage`) | P9 | |
| Batch processing across many files | BL | pipelines/automation (Stirling-style) |
| Public REST API keys, teams/sharing, share links, real-time co-editing | BL | post-v1 |
| Accessibility of ZenPDF UI (WCAG 2.1 AA) | P10 | distinct from PDF remediation tooling (OUT) |
| Account deletion + data export (privacy) | P10 | GDPR-style flows |
| AI assistant (chat/summarize), billing/subscriptions | OUT | removed by owner decision 2026-07-19 |
| Desktop/offline apps, mobile apps | OUT | web-only v1 |
