# Phase 6 — OCR, Conversion & Compare

**Goal:** the scanned-document bridge (OCR), the import/export conversion matrix, PDF/A, repair as a first-class tool, and document compare. All on the heavy queue.

Depends on: Phase 1 (jobs/exports) **and Phase 2B (principal model; OCR/convert/compare are the `METERED_OPS` set — guest rate caps and the Turnstile challenge apply here, §16/§17)**; unlocks the P4 scanned-page CTA.

## Backend

### OCR (`ocr` op — OCRmyPDF)
Params: `languages[]` (default `["eng"]`; ship eng+heb+deu+fra+spa language packs in worker image — owner locale includes Hebrew; more via env `OCR_EXTRA_LANGS` apt list), `deskew`, `rotate_pages`, `clean` (unpaper), `force` (re-OCR pages with existing text: default false → `--skip-text`). Engine runs `ocrmypdf.ocr(in, out, **flags)` in-process; progress plugin hooks map to job progress; counts pages OCR'd → UsageCounter. Result version "OCR". Failure taxonomy mapped: `encrypted` (423 upstream), `tagged_pdf_warning` → proceed, `ocr_engine_error` with page context.

### Conversions IN → new Document (`convert_from` via `/api/operations/`)
Upload/office: docx/xlsx/pptx/odt/rtf/txt → Gotenberg `/forms/libreoffice/convert` (timeouts 300 s; result validated with pikepdf probe). Images (png/jpg/tiff incl. multipage tiff) → PyMuPDF (`fitz.open(img)` → `convert_to_pdf` / `insert_image` per page, A4 fit or original-size option). HTML file → Gotenberg Chromium. **URL → PDF**: `{url}` — layered SSRF guard: (1) API-side pre-check — scheme allowlist http/https only, DNS-resolve → reject private/link-local/metadata ranges (10/8, 172.16/12, 192.168/16, 169.254/16, 127/8, ::1, fd00::/8); (2) Gotenberg hardened with `--chromium-deny-list` covering the same IP-literal patterns plus internal service hostnames (api, db, redis, storage, mailpit), so Chromium-followed redirects can't reach them either; (3) size/time caps. Residual DNS-rebinding risk documented as accepted (deny-list evaluates every navigation).
Import UX is unified with upload: dropzone accepts these types and routes to convert_from automatically.

### Conversions OUT → export (`convert_to`)
- `docx`: pdf2docx (best-effort fidelity — UI copy honest: "layout approximation").
- `images`: PyMuPDF per-page PNG/JPG at chosen DPI (72–300) → zip.
- `txt`: PyMuPDF `get_text` per page with page separators.
- `md`: pymupdf4llm.
- `html`: PyMuPDF `get_text("html")` per page, stitched.
- `pdfa`: OCRmyPDF `--output-type pdfa --skip-text` (PDF/A-2b default; report conversion warnings in result). Validation note: full veraPDF validation = backlog; we assert Ghostscript/OCRmyPDF exit + pikepdf probe.
Exports land in `exports/{job_id}/…` with `GET /api/jobs/{id}/download/` (24 h TTL, §15).

### Repair (`repair`)
pikepdf open with recovery + full save (object streams normalized, xref rebuilt); result "Repaired" version or new doc when invoked from failed upload (P1 flow upgrade: the 415-with-repair-offer path now routes here).

### Compare (`compare`)
Inputs: this document + `other_document_id` (both owned). Engine: (a) **text diff** — per-page `get_text("words")`, aligned with difflib SequenceMatcher → ops list (insert/delete/replace with rects §8 on both sides); (b) **visual diff** — render both @150 dpi, pixel XOR heat regions (ignore <2% noise), rect clusters. Result JSON: `{pages: [{a_page, b_page, text_changes[], visual_regions[]}], summary}` (stored as export JSON + consumed by UI). Page alignment v1 = index-based with an offset control in UI (auto-alignment = backlog).

## Frontend
- "OCR" tool dialog (languages multi-select, cleanup toggles, force) + the P4 scanned-gate CTA now enabled; post-OCR toast "text is now selectable/editable".
- "Convert" tool tab: export grid (Word/Images/Text/Markdown/HTML/PDF-A) with per-format options → job → download button; import handled in dashboard dropzone (accept list + "from URL" input).
- "Compare" (from dashboard multi-select or tool tab): side-by-side synced viewers, change list panel (click → scroll both sides, highlight overlay rects), text/visual toggle. `CompareFacade`.
- Repair surfaced contextually (failed upload flow) + in tools list.

## Tests
Golden: OCR scanned fixture → extractable text contains known strings, skip-text respects existing layer; multipage tiff → page count; docx→pdf→probe; URL guard unit tests (private IP forms, redirects, dns rebind case with mocked resolver); pdf→docx opens via python-docx and contains fixture text; pdfa output passes pikepdf probe + has XMP `pdfaid` marker; compare of fixture vs edited-fixture finds the injected change, visual diff flags the stamped region; repair fixture opens clean after.
E2E: upload scan → OCR (progress bar) → select text in viewer → export Word → compare original vs OCR'd (no text changes, visual identical) → import a docx → converted doc opens.

## Acceptance criteria

- [ ] **Guest parity + tool pages (§20 DoD item 9, §21.6):** every tool in this phase works end-to-end with no account, and ships its public SSR page — `/ocr-pdf` `/pdf-to-word` `/word-to-pdf` `/jpg-to-pdf` `/pdf-to-jpg` `/html-to-pdf` `/compare-pdf` `/repair-pdf` — with unique title/meta/H1 and an entry in the generated `sitemap.xml`.
- [ ] Scanned fixture: OCR completes <60 s/10 pages, text selectable, P4 editor now allowed on it.
- [ ] All six export formats + four import routes produce valid outputs from the UI.
- [ ] URL→PDF refuses `http://169.254.169.254/`, `http://localhost:8000/`, `file:///etc/passwd` with clear errors (tests prove).
- [ ] Compare UI: synced scroll, clickable change list, obviously-correct results on the crafted pair.
- [ ] Hebrew OCR: heb fixture produces RTL text correctly extractable (owner-relevant check).

## Risks
- LibreOffice fidelity variance → Gotenberg pinned major; honest UI copy; fidelity bugs are content-, not architecture-level.
- OCR queue starvation by huge docs → heavy-queue limits (§12) + per-user monthly OCR page quota (§16) + page-count pre-check.

---

**Executed** (see PROGRESS.md §Phase 6). Known drifts between this work order and what shipped are recorded in PROGRESS's
Decisions log; this file is the plan, not the record.
