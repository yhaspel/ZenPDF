# 00 — Research Findings

Research performed 2026-07-19 via web research against current vendor sites, official docs, GitHub repos, PyPI/npm registries. Every version/license claim was checked against a primary source; unverified items are explicitly flagged. Products surveyed:

- **Editors:** Adobe Acrobat Pro (+ AI Assistant/Acrobat Studio), Foxit PDF Editor, Nitro PDF Pro v26, PDF-XChange Editor (+Plus), Wondershare PDFelement, Smallpdf, iLovePDF, Sejda, Xodo, Soda PDF, pdfFiller, Lumin, Stirling-PDF (open-source, v2.10.1, 78k★ — the best open-source feature taxonomy reference).
- **E-sign:** DocuSign, Adobe Acrobat Sign, Dropbox Sign, PandaDoc, SignNow, Documenso (AGPL, v2.14.0), DocuSeal (AGPL, v2.5.3).

## 1. Master feature taxonomy (what "a PDF editor" means in 2026)

1. **Viewing & navigation** — render, print, text search, page thumbnails, bookmarks/outline, metadata viewer, attachments.
2. **Page organization** — merge; split (by range / every N / by size / by bookmarks); reorder (drag-drop); rotate; delete; extract; insert (blank/from another PDF); duplicate; crop; scale; N-up/booklet; alternate-mix (interleave); overlay/background; remove blank pages.
3. **Content editing** — edit existing text (reflow), add text, edit/replace images, hyperlinks, whiteout, find & replace, metadata editing.
4. **Annotation & markup** — highlight/underline/strikethrough, sticky notes, free text, shapes, freehand ink, stamps (standard/custom), comment list/summary, batch-remove.
5. **Forms** — fill AcroForms; create fields (text/checkbox/radio/dropdown/signature); validation; data import/export (FDF/CSV); flatten. (XFA is Adobe-legacy; JS field logic is Acrobat/PXC-only.)
6. **Scan & OCR** — OCR to searchable PDF, language packs, deskew/cleanup, batch.
7. **Conversion** — Office/images/HTML→PDF; PDF→Word/images/text/HTML/Markdown/CSV; PDF/A; repair corrupted files.
8. **Security** — open + permissions passwords (AES-256), unlock, **true redaction** (area + pattern search, incl. image content), sanitize hidden data, digital signatures + validation, certification.
9. **Stamping** — watermarks, headers/footers, page numbers, Bates numbering, overlays.
10. **Compression/optimization** — quality/DPI controls, image downsampling, linearization.
11. **Compare** — side-by-side visual + change report.
12. **Accessibility** — PDF/UA checkers, tagging, reading order (Acrobat/Foxit/PXC only).
13. **Print production/preflight** — Acrobat-exclusive tier (PDF/X, ink management).
14. **AI features** — chat/summarize/translate/AI-redact (out of ZenPDF scope by owner decision).
15. **Collaboration/sharing** — share links, shared review, send-for-signature, co-editing.
16. **Automation/platform** — batch, workflows/pipelines, REST API (Stirling-PDF's strength).

### Table stakes vs differentiators (condensed)

**Table stakes across ALL products incl. free web suites:** view/search/print/thumbnails/bookmarks; full page organization (merge/split/reorder/rotate/delete/extract/insert); add text/image/link overlay; highlight+notes+shapes+ink; form fill + flatten; basic OCR; PDF↔Office/image conversions; password protect/unlock; watermark + page numbers; compression; drawn/typed/uploaded e-signature.

**Differentiators worth adopting in ZenPDF (feasible open-source):** edit existing text with fidelity caveats (desktop suites + Sejda have it; Smallpdf/iLovePDF do NOT — they only overlay); exotic split modes + alternate-mix + N-up (Sejda's niche); true redaction incl. pattern search (regex/SSN/email presets); sanitize; Bates numbering (Acrobat/PXC/Sejda only); PDF/A export; document compare (only iLovePDF among web suites); find & replace; metadata editor; certificate-based digital signatures + verification (Stirling-PDF proves this is self-hostable); full sign-request workflow (every vendor externalizes this to a paid product — bundling it free is ZenPDF's differentiator).

**Consciously out of scope (documented in 02-feature-matrix):** XFA forms, JS form logic, preflight/print production, 3D, accessibility *remediation* tooling (we do a11y of our own UI instead), real-time co-editing, AI features, desktop/offline apps.

### Web-suite scoping lessons (Smallpdf/iLovePDF/Sejda/Lumin)

- They decompose into ~30-45 single-purpose tools; the integrated-workspace experience is the upsell. **ZenPDF should do the opposite: one integrated workspace** (upload once, all tools on the open document) — that is the differentiator vs. the upload→process→download tool farms.
- "Edit PDF" on Smallpdf/iLovePDF = overlay only. Sejda does true text editing but refuses scanned docs (no OCR-to-edit roundtrip). ZenPDF: true text editing via server-side engine, with an honest "scanned page — run OCR first" gate (same policy as Sejda, but we *have* the OCR bridge).
- Web suites all process server-side; privacy objections are countered with auto-deletion policies and clear retention statements — ZenPDF must publish the same (see phase 9/10).

## 2. E-signature canonical model (from DocuSign/Adobe/Documenso/DocuSeal)

**Workflow:** envelope (= sign request) → recipients with roles (Signer / Approver / Viewer / CC) → sequential, parallel, or mixed routing order → per-recipient fields placed on pages (signature, initials, date-signed, text, checkbox) → email invites with tokenized links → view → consent → fill/sign → complete. Decline (with reason) and cancel are first-class. Reminders (auto, ~every 3 days) + expiration (~30 days default). Templates and bulk-send are upper-tier features (ZenPDF backlog).

**Signature capture (universal trio):** draw (canvas), type (cursive font choices), upload image. Adopted signatures are stored on the profile for reuse. The *legal* signature is the recorded act + audit trail + tamper seal — not the image.

**Audit trail must record (DocuSign Certificate of Completion is the benchmark):** envelope ID (also stamped on document pages), per-recipient name/email/role, authentication level used, **IP address + user agent per action**, UTC-timestamped event log (created, sent, viewed, consented, signed, declined, completed), consent disclosure acceptance, final document SHA-256 hash, per-signature IDs. Completion produces a **certificate of completion PDF**.

**Tamper-evident sealing:** completed PDFs are cryptographically signed with a **platform certificate** (X.509). Documenso/DocuSeal model (the self-hosted baseline ZenPDF follows): the instance operator configures a `.p12` certificate — self-signed for dev, CA-issued for production — and the platform applies a PAdES signature at completion; any byte change invalidates it.

**Compliance (what ZenPDF must implement to be ESIGN/UETA-sound):**
1. **Intent** — explicit click-to-sign act;
2. **Consent** — electronic-business consent disclosure shown and its acceptance logged;
3. **Association** — audit trail logically attached to the record (hash + embedded stamp + certificate doc);
4. **Retention** — all parties can download the completed document + certificate.

**eIDAS levels:** SES (what our default flow produces — legally valid, evidence = audit trail) < AES < QES (requires Qualified TSP + QSCD — out of scope; commercial vendors sell this as an add-on). ZenPDF = SES with cryptographic platform seal, same as Documenso/DocuSeal.

**PAdES (ETSI EN 319 142) levels:** B-B (basic) → B-T (+ RFC 3161 timestamp) → B-LT (+ embedded revocation/chain data = LTV) → B-LTA (+ archival timestamps). pyHanko (MIT) supports all four. ZenPDF: B-T by default (works with self-signed dev certs + public TSA), B-LT when a real CA cert + TSA are configured.

## 3. Verified stack facts (full table in 01-architecture.md)

- **Angular 22.0** (2026-06-03) is latest stable; zoneless is the default since v21; **OnPush is the default change-detection for new components in v22**; Signal Forms stable. Angular 20 is LTS-ending Nov 2026; v21 LTS.
- **Django 6.0.7** is latest stable (6.0 released 2025-12-03; supports Python 3.12–3.14). 5.2.16 is the LTS fallback (supported to Apr 2028). **DRF 3.17.0 (2026-03-18) officially added Django 6.0 support.**
- **PDF.js v6.1** (Apache-2.0): viewer + annotation *editor* limited to FreeText, Ink, Stamp, Highlight, Signature — **cannot edit existing page text**. No open-source JS library can; only commercial WASM SDKs (Apryse, Nutrient) do in-browser content editing. → ZenPDF edits content **server-side** (PyMuPDF) and re-renders.
- **ngx-extended-pdf-viewer 28.1.0** (2026-07-10, Apache-2.0) supports Angular 19–22.
- **PyMuPDF 1.28.0** — AGPL-3.0/commercial dual license (accepted by owner). Capabilities confirmed: page→PNG rendering, text/image extraction with coordinates, **true redaction** (`add_redact_annot`/`apply_redactions`), text insertion (`insert_htmlbox` with font fallback), `subset_fonts`, all annotation types, form widget fill/create. Text-editing approach = redact old bbox + reinsert; original embedded fonts are subsets so replacement uses a substitute full font, then re-subset. Documented constraints: bbox-intersection over-deletion risk, replacement must fit vacated box.
- **pikepdf 10.10.0** (MPL-2.0) — qpdf-based: encryption AES-256, linearization, repair, page ops. **pypdf 6.14.2** (BSD).
- **OCRmyPDF 17.8.1** (MPL-2.0) — searchable-PDF layer + PDF/A output; requires Tesseract 5.5 (Apache-2.0) + Ghostscript (AGPL — accepted).
- **pyHanko 0.35.2** (MIT) — PAdES B-B/T/LT/LTA, RFC 3161, validation. README notes beta status (0.x) — it is nonetheless the standard Python PAdES implementation.
- **Gotenberg 8.34.0** (MIT) — Docker REST API wrapping Chromium (HTML/URL→PDF) + LibreOffice (Office→PDF, PDF/A) + QPDF/pdfcpu/ExifTool.
- **pdf2docx** (relicensed **MIT**, archived by Artifex but functional; built on PyMuPDF) — PDF→Word. **pymupdf4llm** (AGPL) — PDF→Markdown.
- **reportlab 5.0.0** (BSD-3) — generates the certificate-of-completion PDF. Note: 5.0 is a brand-new major (June 2026); check changelog when pinning.
- **signature_pad 5.1.3** (MIT) — canvas signature drawing.
- **⚠ MinIO is dead for new projects**: repo archived, community images stopped Oct 2025, maintenance mode Dec 2025. Replacement for local S3-compatible storage: **SeaweedFS** (Apache-2.0, active, single-container `server -s3` mode with static-credentials JSON).
- **Mailpit v1.30** (MIT) — local SMTP capture.
- Node 24 LTS; Python 3.14.6; PostgreSQL 18; Celery 5.6.3; Redis 8 (AGPL — accepted; Valkey 8 is the BSD drop-in if ever needed).
- **⚠ Flagged for scaffold-day re-verification** (see phase 0): djangorestframework-simplejwt 5.5.1 predates Django 6.0 — confirm compatibility or pin newer; which pdf.js major ngx-extended-pdf-viewer 28.1.x bundles; Angular 22's default unit-test runner.

## 4. Sources (primary ones actually used)

**Editors:** github.com/Stirling-Tools/Stirling-PDF · docs.stirlingpdf.com/functionality · smallpdf.com/pdf-tools · ilovepdf.com · sejda.com · foxit.com/pdf-editor · adobe.com/acrobat/pricing/compare-versions.html · pdf-xchange.com/pdf-xchange-products-comparison-chart · gonitro.com/release-hub/nitro-pdf-pro-26 · pdf.wondershare.com · xodo.com/tools · redactproof.com/resources/compare/adobe-acrobat

**E-sign:** support.docusign.com (Certificate of Completion; recipient types; in-person; reminders) · developers.docusign.com (recipients/auth) · helpx.adobe.com/sign (roles; routing; audit report; auth methods) · sign.dropbox.com/features · pandadoc.com (certificates; QES; identity verification) · signnow.com/features · github.com/documenso/documenso (+SIGNING.md, docs.documenso.com) · github.com/docusealco/docuseal (+docuseal.com/docs/api) · ec.europa.eu eIDAS eSignature FAQ · etsi.org (PAdES) · pdfa.org (LTV)

**Stack:** angular.dev/reference/releases · angular.dev/guide/zoneless · blog.angular.dev/announcing-angular-v21 · angular.dev/events/v22 · djangoproject.com/download · docs.djangoproject.com/en/dev/faq/install · django-rest-framework.org/community/release-notes (3.17: Django 6.0) · python.org/downloads · nodejs.org/en/about/previous-releases · postgresql.org/support/versioning · github.com/mozilla/pdf.js/releases (v6.1.200) · npmjs.com/package/ngx-extended-pdf-viewer · pypi.org (PyMuPDF, pikepdf, pypdf, ocrmypdf, pyHanko, reportlab, celery, DRF, simplejwt, cors-headers, drf-spectacular, django-storages) · artifex.com/licensing · github.com/pymupdf/PyMuPDF/discussions/3906 + /3499 (text-edit constraints) · pymupdf.readthedocs.io/en/latest/recipes-text.html · gotenberg.dev · github.com/gotenberg/gotenberg · github.com/ArtifexSoftware/pdf2docx (MIT relicense) · github.com/minio/minio (archived=true) + blocksandfiles.com + github.com/minio/minio/issues/21714 · github.com/seaweedfs/seaweedfs/wiki/S3-Configuration · github.com/axllent/mailpit/releases · npmjs.com/package/signature_pad · nutrient.io/blog/complete-guide-to-pdfjs (PDF.js editor scope corroboration) · apryse.com/products/webviewer
