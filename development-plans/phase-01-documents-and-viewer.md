# Phase 1 — Documents & Viewer

**Goal:** users can upload, organize, open, read, search, and manage PDFs; the versioning/undo backbone and viewer workspace exist for all later tools.

Depends on: Phase 0. Conventions: 01-architecture §§8–16.

## Backend

### Models (activate from §9)
`Folder`, `Document`, `DocumentVersion` + denormalized `User.storage_bytes_used`.

### Ingest pipeline (synchronous validation, async post-processing)
`POST /api/documents/` (multipart: file, title?, folder?) →
1. quota check (storage + size cap) → 413/429 error codes;
2. magic-bytes `%PDF` + `pikepdf.open` probe: on parse failure respond 415 `unsupported_file` with `details.repair_offer=true` (client may retry with `?repair=true` → routes through `repair` op, phase 6 engine fn — stub returns clean copy via pikepdf save, implemented properly in P6 but basic save-normalize works now);
3. encrypted? → create with `is_encrypted=true` (operations blocked with 423 until `decrypt` in P7; viewing allowed if PDF.js can open with user-supplied password client-side — pass password to viewer only, never store);
4. stream to storage as v1 "Original", sha256, page_count/size via PyMuPDF;
5. Document `ready`; enqueue `generate_thumbnails` (first 20 pages @240px) on render queue.

### Endpoints
| Method/Path | Behavior |
|---|---|
| `GET /api/documents/` | list: filter `folder`, `starred`, `trashed`, `q` (title icontains), ordering (updated, title, size) |
| `GET/PATCH /api/documents/{id}/` | detail (incl. current_version, counts) / rename, move folder, star |
| `DELETE /api/documents/{id}/` | soft-delete (trashed_at); `POST …/restore/`; `DELETE …/?permanent=true` from trash |
| `GET /api/documents/{id}/content/` | Range-supporting stream of current (or `?version=seq`) — §13 |
| `GET /api/documents/{id}/pages/{n}/thumbnail/?w=` | cached render §13 |
| `GET /api/documents/{id}/versions/` | history (seq, label, size, created_by, job type) |
| `POST /api/documents/{id}/versions/{seq}/revert/` | undo model §14 (job, default queue) |
| `GET /api/documents/{id}/outline/` | table of contents (PyMuPDF `get_toc`) |
| `GET /api/documents/{id}/text-search/?q=&page=` | server search fallback (PyMuPDF `search_for`, normalized rects §8) — used for cross-page hit list |
| `GET /api/folders/` CRUD | nested folders; delete only when empty (or `?cascade=trash`) |
| `GET /api/users/me/usage/` | storage used/quota, counters |
| `GET /api/documents/{id}/download/` | attachment disposition of current version |

### Engine functions implemented now
`inspect(bytes) -> {pages, size, encrypted, metadata, toc}` · `render_page(bytes, page, width) -> png` · `search_text(bytes, q) -> hits` · thumbnail task. Golden tests per corpus.

## Frontend

- **Dashboard** (`/app/dashboard`): folder tree (left), document grid/list toggle with thumbnails, upload dropzone + button (multi-file, per-file progress, queue), search box, star filter, trash view with restore/purge, storage usage meter (from usage endpoint), context menu (rename/move/star/trash/download). Facades: `DocumentsFacade` (list state, filters, optimistic rename/star), `UploadFacade` (parallel uploads, progress signals), `FoldersFacade`.
- **Workspace** (`/app/doc/:id`): ngx-extended-pdf-viewer center (page nav, zoom, fit, rotate-view, print, text-selection, find bar via viewer's built-in search); left rail: thumbnails (click-to-jump) + outline tab + version history tab (revert with confirm); right rail: tool panel scaffold with placeholder tabs for later phases; top bar: title (inline rename), info popover (read-only metadata: author, created/modified, page count, size — editing arrives in P4), download, job status indicator. `ViewerFacade`: current doc/version signals, reload-on-new-version, page state; `VersionsFacade`.
- Viewer loads via `content/` URL with JWT — pass through interceptor-friendly `src` (viewer supports Blob/src with httpHeaders; use its `httpHeaders` input or fetch Blob ourselves — decide on scaffold, test Range behavior with both, keep the one where PDF.js range-chunking works through our proxy).
- Encrypted docs: password dialog → viewer-only open (client-side), banner "Locked — unlock to edit (Security tools)".

## Infra
No new services. `seed_dev` now uploads the fixture corpus for the demo user.

## Tests
Backend: ingest happy path (+sha256/page_count correctness), quota rejection at exact boundary, corrupt-file 415 + repair retry, encrypted-file flagging, trash/restore/purge (purge frees quota), version revert creates new head, Range requests (200 full, 206 partial, If-None-Match 304), thumbnail cache hit (second call served from storage), folder cascade rules, cross-user isolation (404 on others' docs — test EVERY endpoint with a second user; write it as a shared pytest fixture applied to the whole router).
Frontend: upload facade (progress, failure retry), documents facade filter logic.
E2E: upload 2 PDFs → open one → jump via thumbnail → find text → rename → trash → restore.

## Acceptance criteria
- [ ] Upload 50 MB PDF: progress shown, thumbnail appears, opens in viewer in <3 s on warm cache.
- [ ] In-viewer text search highlights hits; outline navigates; 500-page fixture scrolls smoothly (virtualized rendering by viewer).
- [ ] Version history shows "Original"; revert appears after any later-phase op (verified again in P2).
- [ ] Trash → gone from library, restorable for 30 days (beat purge configured), purge updates storage meter.
- [ ] A second account cannot access the first account's documents by ID (proved by tests).
- [ ] Encrypted fixture opens with password, operations blocked with clear messaging.

## Risks
- Range/streaming quirks between PDF.js and Django proxy → mitigated by the dual-mode decision above + explicit 206 tests.
- Huge PDFs (2000-page cap) thumbnailing cost → thumbnails are lazy beyond first 20 pages (on-demand endpoint renders + caches).
