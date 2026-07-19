# Phase 4 — Content Editing

**Goal:** the differentiator cluster: edit existing text, add text, manage images and links, whiteout, find & replace, plus the stamping suite (headers/footers, page numbers, watermarks, Bates, overlay) and metadata/bookmark editing. Server-side engine (PyMuPDF); honest UX about fidelity limits.

Depends on: Phase 3 (overlay layer).

## Text editing — design (the hard part, speced precisely)

**Read model:** `GET /api/documents/{id}/text-blocks/?page=` → PyMuPDF `page.get_text("dict")` distilled to editable **blocks**: `{block_id, bbox §8, lines: [{bbox, spans: [{text, font, size, color, flags(bold/italic), bbox}]}], is_scanned_page: bool}`. Pages with no extractable text and full-page images ⇒ `is_scanned_page=true`.

**Edit model (block-scoped, v1):** user clicks a block → overlay swaps in a styled editor (textarea positioned over bbox, font-size/family approximated from dominant span; multi-line preserved). On commit, client sends `edit_text` op: `{edits: [{page, block_bbox, new_text, style: {font_family, size, color, align}}]}`.

**Engine algorithm (`content.py: edit_text`):**
1. `add_redact_annot(block_bbox + 1pt padding)` → `apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)` — removes old glyphs only, never neighboring images;
2. reinsert via `insert_htmlbox(bbox, html-escaped text with style)` — auto font fallback incl. CJK; if overflow: shrink-to-fit down to 65% of original size, else return job error `text_overflow` with `details.fits_at_size` so UI offers "shrink to N pt / enlarge box / cancel";
3. `subset_fonts()` before save (file-size control).
**Documented constraints (also shown in UI on first use):** editing is block-granular (no cross-block reflow); replacement font is a visual approximation when the original embedded font is a subset (typical); tight line-spacing may over-select — the preview shows exactly what will be replaced. **Scanned pages:** editor blocked with "This page is a scan — run OCR first" CTA (links to P6 tool; Sejda-parity policy with a better answer).

**Find & replace:** two-step. `POST …/operations/ {type: find_replace, params: {find, match_case, dry_run: true}}` → result: matches `[{page, rect, context}]`; UI shows list with checkboxes → second call `dry_run:false, only: [match ids]` executes via the same redact+reinsert primitive per match (span-scoped, inherits span style).

## Other editing features

- **Add text**: overlay text boxes → `add_text` (insert_htmlbox at rect; style controls).
- **Whiteout**: rects → draw filled white rect in content (NOT redaction — document the difference in UI copy: "hides visually; use Redact to remove content permanently").
- **Images**: `GET …/images/?page=` (xref, bbox, dims via `page.get_images` + `get_image_rects`); ops: `add_image` (upload → insert_image at rect, keep-aspect option), `replace_image` (same rect, new bytes), `delete_image` (redact-image at rect with `PDF_REDACT_IMAGE_REMOVE`, text preserved).
- **Links**: `GET …/links/?page=` (`page.get_links`); `add_link/edit_link/delete_link` (uri or internal page target; rects §8).
- **Headers/footers & page numbers**: dialog with 6 slots (L/C/R × header/footer), token insertion ({page}, {total}, {date}, custom text), font/size/color, margins, page range, "skip first page" — engine draws via `insert_htmlbox` in margin bands.
- **Watermark**: text (content, size, color, opacity, rotation −45° default, tiled or centered) or image (upload, scale, opacity), range; drawn under or over content (overlay flag; under = `page.insert_htmlbox(..., overlay=False)`).
- **Bates numbering**: prefix/suffix, start number, zero-pad digits (default 6), position, range — applied atomically across the doc; job result reports first/last stamped values. (Multi-doc batch Bates = backlog.)
- **Overlay PDF** (letterhead/background): `overlay_pdf` — `show_pdf_page` of overlay page onto range, fore/background.
- **Metadata & bookmarks**: `set_metadata` (title/author/subject/keywords, clear-all switch) with form UI; `set_bookmarks` — outline editor (tree with add/rename/re-nest/delete, "set to current page") → `set_toc`.

## Frontend
Tool tabs: "Edit" (text/image/link/whiteout modes on overlay), "Stamps" (watermark/header-footer/page numbers/Bates/overlay dialogs), "Info" (metadata + bookmarks editors). `EditFacade` (blocks cache per page, edit session batching — multiple block edits commit as one `edit_text` job), `StampsFacade`. Live preview for stamp dialogs: client-side canvas approximation over thumbnail (clearly labeled "preview"), authoritative result after job.

## Tests
Golden: edit_text replaces text (extract shows new), neighbors untouched (text + images), overflow path returns `text_overflow` with fit size, unicode + RTL fixture edits, subset_fonts keeps size sane (<1.5× original), find_replace dry-run counts = executed count, whiteout leaves text extractable underneath (documented behavior!), delete_image removes only target, links round-trip, header tokens compute ({total} correct), Bates continuity across range, watermark under-content doesn't obscure extraction, metadata/TOC round-trip.
E2E: edit a paragraph → save → text visibly changed → find&replace 3 of 5 matches → add page numbers → set title metadata → all versions labeled and revertible.

## Acceptance criteria
- [ ] Click-to-edit works on the text fixture with visually acceptable output (side-by-side pixel diff <15% in edited block region for same-text roundtrip sanity test).
- [ ] Scanned-page gate appears on scanned fixture with working OCR CTA (disabled until P6, tooltip "coming with OCR tool" — then enabled).
- [ ] Find & replace with preview/deselect works across a 50-page doc in <60 s.
- [ ] All stamp tools produce correct output honoring range + skip-first.
- [ ] Whiteout vs Redact distinction communicated in UI (copy reviewed).

## Risks
- Fidelity complaints on exotic fonts → constraints documented in-product; block-scoped model keeps blast radius small; pixel-diff sanity test defines "acceptable".
- `insert_htmlbox` behavior changes across PyMuPDF versions → engine pinned (§2); golden tests catch regressions on upgrade.
