# Phase 3 — Annotations & Markup

**Goal:** full markup toolset writing **real PDF annotations** (interoperable with Acrobat/Preview): text markup, notes, free text, shapes, ink, stamps; comments sidebar; flatten. Also: the overlay interaction layer reaches production quality here (reused by phases 4/5/7/8).

Depends on: Phase 2 (overlay primitive started in crop).

## Design decisions

1. **PDF-native storage.** Annotations live in the PDF file itself (PyMuPDF creates standard annots), not in a sidecar DB. Reading = extract to JSON; writing = `annotate_batch` op producing a new version. Rationale: downloads/interop "just work"; versioning/undo comes free; no dual-source-of-truth drift.
2. **Session batching.** The client accumulates changes locally (overlay renders drafts instantly) and commits explicit **Save** (or autosave every 30 s / on navigation) as ONE `annotate_batch` job — avoids a version per keystroke. Unsaved-changes guard on exit.
3. **Identity.** Each annot's `title` (author) = user display name; `NM` (name) = client-generated UUID so batch updates/deletes address stable IDs across extract/apply cycles.
4. We do NOT use PDF.js's built-in annotation editor UI (its model doesn't round-trip through our pipeline); the overlay layer is ours. PDF.js *renders* existing annotations.

## Backend

### Endpoints
- `GET /api/documents/{id}/annotations/?version=` → `[{id(NM), page, type, rect|quads|inkList|vertices (normalized §8), color, opacity, contents, author, created, modified, …per-type}]` via PyMuPDF extraction.
- `annotate_batch` op (§10): `ops: [{action: add|update|delete, annotation: {…}}]`. Per-type schemas: `highlight|underline|strikeout|squiggly` (quads from text selection), `note` (point + contents + icon), `free_text` (rect, text, font size, color, border), `square|circle|line|arrow|polygon|polyline` (geometry, stroke/fill, width), `ink` (strokes[][]), `stamp` (built-in name from standard set) and `image_stamp` (uploaded PNG ref — engine: `add_stamp_annot` for standard stamps; custom images applied as a Stamp annot with a custom appearance stream; sanctioned fallback if appearance fidelity fails its golden test: draw via `insert_image` and track as ZenPDF annot subtype "flattened stamp" — both paths speced, the golden test decides on day one).
- `flatten` op with `what=annotations` — **implementation directive:** `Document.bake()` (available since PyMuPDF 1.24.2) bakes annotations (and widgets, used by P5) into page content and removes the annotation objects. Golden test proves annotations survive visually (pixel-compare region) and are gone as objects.
- Batch-remove: `annotate_batch` with delete ops (client provides "clear page/document" affordances).

### Engine
`annotations.py`: extract_annotations, apply_annotation_ops (add/update/delete by NM), flatten_annotations (bake). Color/opacity/rotation handling normalized; all geometry through `geometry.py`.

## Frontend

- **Tool tab "Annotate"**: tool palette (select, highlight, underline, strikeout, squiggly, note, text box, rectangle, ellipse, line, arrow, polygon, ink, stamp), color/opacity/width controls, standard-stamp picker + "upload stamp" (stored client-side per session; server ref via temp upload).
- **Overlay layer v2** (`PageOverlayComponent`): renders draft + existing annotations as SVG/positioned divs above each page; selection handles (move/resize); text-markup tools consume PDF.js text-layer selection → quads; ink uses pointer events with pressure-agnostic smoothing; ESC cancels; delete key removes selection. All geometry stored normalized (§8); zoom-independent.
- **Comments sidebar**: list grouped by page (author, snippet, time), click-to-jump, edit own contents inline, delete; "clear all" with confirm.
- **Save model UX**: dirty badge + Save button + autosave timer + `beforeunload` guard; on save → single job → version "Annotated"; on 409 → merge dialog is NOT attempted (v1): "Reload & reapply" keeps local drafts and replays them on the fresh version (drafts are independent objects — replay is safe; conflicting deletes surface as no-ops).
- `AnnotationsFacade`: draft store (signal map by NM), dirty tracking, extract-on-load, batch composer.

## Tests
Golden: each annot type round-trips (create → extract → fields match; open output in pypdf to assert `/Annots` present); update moves rect; delete removes; flatten bakes (annots gone, pixels changed in region); quads correct on rotated fixture. API: schema rejection of malformed ops, cross-user isolation. Frontend: overlay geometry math (normalized↔screen under zoom+rotation), draft replay logic. E2E: highlight text → add note → draw arrow → save → reload → all present → flatten → sidebar empty → version history shows both steps.

## Acceptance criteria
- [ ] All listed tools usable; annotations visible after download in an external viewer (manual check with Preview/Acrobat reader on the exported file).
- [ ] Save of a 30-annotation session = ONE job, <5 s on default queue.
- [ ] Comments sidebar navigates and edits; authorship shows display name.
- [ ] Flatten produces a version where text markup is permanent and no annotation objects remain.
- [ ] Autosave + unsaved-changes guard verified.

## Risks
- Custom image stamps appearance-stream fidelity → dual-path spec above, resolved by golden test day one.
- Text-layer selection quality on odd PDFs (ligatures, RTL) → quads come from PDF.js's own text layer, matching what the user sees; add a Hebrew/RTL fixture to the corpus and an explicit test (relevant to owner's locale).
