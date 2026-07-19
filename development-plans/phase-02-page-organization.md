# Phase 2 — Page Organization

**Goal:** full page-management toolset (the #1 table-stakes cluster): merge, split, reorder, rotate, delete, duplicate, extract, insert, crop, scale, N-up, alternate-mix, compress — all through the job pipeline with undo via versions.

Depends on: Phase 1.

## Backend

### Engine functions (`pdf_engine/engine/pages.py`) — all pure `(bytes|bytes[], params) -> bytes|bytes[]`
PyMuPDF: `rotate_pages`, `delete_pages`, `duplicate_pages`, `reorder_pages` (`Document.select`), `extract_pages`, `insert_blank` (page sizes A4/Letter/match-previous), `insert_from_document` (`show_pdf_page`/`insert_pdf`), `merge` (`insert_pdf` sequential, preserve TOCs concatenated with doc-title parents), `split_*` (ranges / every_n / by_size_mb (greedy pack by rendered size) / by_bookmarks (level-1 splits)), `alternate_mix` (optional reverse of B for flatbed scans), `nup` (2/4-up via `show_pdf_page` grid), `crop_pages` (set cropbox from §8 rect), `scale_pages` (new page + `show_pdf_page` scaled), `compress` (presets: light=`ez_save`, balanced=+image recompress to target DPI via Pixmap re-encode, strong=+grayscale option; report before/after sizes in job result; fallback note: if ratio <3% return "already optimized").
Validation guardrails in every fn: page indexes in range, ≥1 page must remain after delete/extract, reorder must be a permutation, insert source ≠ target version race handled by lock (§11).

### API
Uses the generic operations endpoints (§10, §11): single-doc ops via `/api/documents/{id}/operations/`; `merge`/`alternate_mix` via `/api/operations/` (multi-source, ownership check on every source; result = new Document(s) in the same folder, titled "Merged — {first} (+N)" etc.). `split`/`extract(as_new_document)` produce new Documents; job result lists them.

## Frontend

- **Organize mode** in workspace (tool tab "Pages"): thumbnail grid becomes the editing surface — multi-select (click/shift/ctrl), CDK drag-drop reorder, per-page rotate buttons, toolbar: rotate/delete/duplicate/extract/insert/crop/…; destructive actions confirm; every action = one operation job with `base_version_seq` (§11) then reload. Conflict (409) → "Document changed — refreshed" flow.
- **Merge**: from dashboard multi-select → "Merge" dialog (order list, drag) → job → navigate to result.
- **Split dialog**: mode tabs (ranges via text input "1-3,7,9-12" with live validation + visual range preview; every N; by size; by bookmarks (disabled with hint when no TOC)).
- **Crop**: overlay rectangle on the live page (first use of the overlay layer primitive — build `PageOverlayComponent` generic here, matures in P3), apply-to: current/all/range.
- **Compress dialog**: preset radio + estimated note; result toast with size delta (“12.4 MB → 3.1 MB, −75%”).
- `PagesFacade` (selection state, op dispatch), reuse `JobsFacade`.

## Tests
Golden tests per engine fn on corpus (rotated fixture reorder keeps rotation; merge of unicode+form keeps form fields; split ranges page counts; alternate_mix interleave order; crop rect honored under 90° rotation — geometry regression; compress reduces scanned fixture ≥30%, never corrupts (re-inspect after)). API: permission checks on merge sources, base_version conflict path, ≥1-page rule, job results create documents in folder.
E2E: open doc → reorder via drag → rotate page → delete page → undo via version revert → merge two docs from dashboard → split result by ranges.

## Acceptance criteria
- [ ] All 14 page operations usable from UI, each producing a labeled version ("Rotated 2 pages", "Merged", …) visible in history and revertible.
- [ ] Drag-reorder of a 100-page doc feels instant (optimistic thumbnail order, reconciled on job success).
- [ ] Split by bookmarks on the TOC fixture yields correctly named docs ("{title} — {bookmark}").
- [ ] Compress on scanned fixture: ≥30% reduction, text layer intact.
- [ ] Two tabs editing the same doc: second op gets the 409 refresh flow, no corruption (versions immutable).

## Risks
- PyMuPDF TOC/link preservation on `select`/`insert_pdf` edge cases → golden tests assert TOC survival; document known losses in UI copy ("links between removed pages are dropped").
- by_size split estimation accuracy → greedy pack + post-check actual sizes, adjust.
