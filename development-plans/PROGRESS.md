# ZenPDF — Progress Tracker (canonical)

This file is the **single source of truth for execution status**. Every agent session working on ZenPDF must read it first and update it continuously. The phase docs define *what* to build; this file records *what actually happened*.

## Status overview

| Phase | Doc | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| 0 — Foundation | [phase-00-foundation.md](phase-00-foundation.md) | ✅ Complete | 2026-07-19 | 2026-07-19 | Auth, jobs, Docker stack, infra scripts |
| 1 — Documents & viewer | [phase-01-documents-and-viewer.md](phase-01-documents-and-viewer.md) | ✅ Complete | 2026-07-19 | 2026-07-19 | Ingest, viewer, versions, search, trash |
| 2 — Page organization | [phase-02-page-organization.md](phase-02-page-organization.md) | ✅ Complete | 2026-07-19 | 2026-07-19 | 14 page ops via job pipeline |
| 3 — Annotations | [phase-03-annotations.md](phase-03-annotations.md) | ⬜ Not started | — | — | |
| 4 — Content editing | [phase-04-content-editing.md](phase-04-content-editing.md) | ⬜ Not started | — | — | |
| 5 — Forms | [phase-05-forms.md](phase-05-forms.md) | ⬜ Not started | — | — | |
| 6 — OCR, conversion & compare | [phase-06-ocr-conversion-compare.md](phase-06-ocr-conversion-compare.md) | ⬜ Not started | — | — | |
| 7 — Security & redaction | [phase-07-security-redaction.md](phase-07-security-redaction.md) | ⬜ Not started | — | — | |
| 8 — E-signatures | [phase-08-esignatures.md](phase-08-esignatures.md) | ⬜ Not started | — | — | Human gate: legal text + prod cert |
| 9 — Ads & abuse controls | [phase-09-ads-and-abuse-controls.md](phase-09-ads-and-abuse-controls.md) | ⬜ Not started | — | — | Human-owned: AdSense/CMP accounts, legal pages |
| 10 — Hardening & release | [phase-10-hardening-release.md](phase-10-hardening-release.md) | ⬜ Not started | — | — | Human-owned: domain/DNS/TLS, deploy creds, sign-offs |

Status values: ⬜ Not started · 🔵 In progress · 🟡 Blocked · 🟠 Awaiting human review · ✅ Complete (all acceptance criteria + DoD evidenced below)

## Update protocol (mandatory for every agent session)

1. **On session start:** read this file top to bottom. Resume from the first non-✅ phase. Never re-do ✅ work; never skip a 🟡 blocker without resolving it.
2. **On phase start:** set status 🔵 with date; copy that phase's *Acceptance criteria* checklist verbatim into the phase section below.
3. **During work:** append Session log entries (date, what was done, key commands/results). Record every deviation or decision in the Decisions log — a decision without a written rationale is a bug.
4. **On acceptance check:** tick each criterion only with one line of evidence (test name + count, command output summary, or e2e spec name). Unproven ticks are forbidden.
5. **On phase completion:** verify the Definition of Done ([01-architecture.md](01-architecture.md) §20), set ✅ with date, update the status table, commit.
6. **On blocker:** set 🟡, fill a Blockers entry (symptom, what was tried, smallest human decision needed), STOP work on that phase.
7. **Human review items:** add to the Human review queue; these do not block progress unless marked GATE.

## Verified pins (fill during Phase 0.1 scaffold-day checklist)

| Item | Result | Date |
|---|---|---|
| simplejwt × Django 6.0 | ✅ simplejwt 5.5.1 installs & imports alongside Django 6.0.7 in image; runtime auth flow verified by tests (0.5). No LTS fallback needed. | 2026-07-19 |
| ngx-extended-pdf-viewer bundled pdf.js | ✅ **28.1.0** (Apache-2.0), pdf.js **vendored inside the viewer's `/assets`** (no separate `pdfjs-dist` dep). Renders + text layer + range-chunking work through the API proxy with `[httpHeaders]` JWT (viewer e2e green). @angular/cdk 22.0.5. | 2026-07-19 |
| Angular 22 default test runner | ✅ **Vitest 4** (`@angular/build:unit-test` builder + jsdom 28). Karma is gone in v22. TS ~6.0. Note: Jasmine `done` callback unsupported → Promise-based async tests. | 2026-07-19 |
| Tailwind 4 install path | ✅ **tailwindcss 4.3.3** via `@tailwindcss/postcss` in `.postcssrc.json` + `@import "tailwindcss";` in a plain `src/tailwind.css` (kept out of SCSS so Sass doesn't intercept the import). Compiles + serves. | 2026-07-19 |
| Engine imports on python:3.14-slim | ✅ python 3.14.6. `import fitz, pikepdf(10.10.0), ocrmypdf(17.8.1), pyhanko, reportlab, pdf2docx, pymupdf4llm` all OK. Binaries: tesseract 5.5.0, gs 10.05.1, unpaper, pngquant, qpdf present. **No 3.13 fallback needed.** | 2026-07-19 |
| SeaweedFS tag + boto3 smoke test | ✅ **chrislusf/seaweedfs:3.97** (`server -s3`, static creds). boto3 path-style (`AWS_S3_ADDRESSING_STYLE='path'`) put/get/head/Range all work — exercised by `init_storage`, ingest, thumbnail cache, and 206 Range streaming in the running stack. | 2026-07-19 |
| Drifted pins refreshed (nginx, django-filter, drf-spectacular, boto3) | django-filter 25.2, drf-spectacular 0.30.0, boto3 1.40.0 pinned; nginx `stable-alpine` pinned at compose. reportlab pinned 4.4.4 (5.0 major deferred — see Decisions). | 2026-07-19 |

## Phase sections

_(Created by the executing agent per protocol step 2. Keep newest phase at top.)_

### Phase 2 — Page Organization · ✅ Complete (2026-07-19)

**Acceptance criteria** (from phase-02-page-organization.md):
- [x] All 14 page operations usable from the UI, each producing a labeled version, visible in history and revertible. → Organize toolbar + tool dialogs dispatch rotate/delete/duplicate/reorder/extract/insert_blank/insert_from_document/crop/scale/nup/compress/split; merge/alternate_mix via `/api/operations/`. Golden tests: `test_engine.py` (26 op tests), API tests `test_operations.py` + `test_more_ops.py`. Labels e.g. "Rotated 1 page(s)", "Merged — …".
- [x] Drag-reorder optimistic + reconciled on job success. → `PagesFacade`/organize grid CDK drag → `reorder_pages` with `base_version_seq`; order re-derived on version change.
- [x] Split by bookmarks names docs "{title} — {bookmark}". → `test_split_by_bookmarks_named`.
- [x] Compress on scanned fixture ≥30% reduction, text layer intact. → `test_compress_scanned_reduces` (−57%), re-inspect asserts pages intact.
- [x] Two tabs editing same doc: second op → 409 refresh flow, no corruption. → `test_base_version_conflict` (job fails `version_conflict`); UI `handleFailure` → "Document changed — refreshed" + reload. Versions immutable.
- **e2e:** `phase-2.spec.ts` — organize → rotate → delete → revert (version history) → merge two docs → split by ranges. Green.

### Phase 1 — Documents & Viewer · ✅ Complete (2026-07-19)

**Acceptance criteria** (from phase-01-documents-and-viewer.md):
- [x] Upload with progress, thumbnail appears, opens in viewer. → `UploadFacade` (per-file progress events), `generate_thumbnails_task`, ngx-extended-pdf-viewer via `content/` + JWT `httpHeaders`. `test_ingest.py`, e2e upload of 2 PDFs.
- [x] In-viewer text search + outline nav; 500-page fixture scrolls (viewer virtualization). → server `text-search` (`search_text`, normalized rects) surfaced in workspace find bar; `outline/` from `get_toc`; `large-generated.pdf` (500p) fixture. `test_content.py::test_outline_and_search`.
- [x] Version history shows "Original"; revert appears after later-phase op. → `VersionListView`; `test_versions_trash.py::test_version_history_and_revert` (Original + Rotated + Reverted).
- [x] Trash → gone from library, restorable 30 days (beat purge configured); purge updates storage meter. → soft-delete `trashed_at`, `restore/`, `?permanent=true` frees quota; `test_trash_restore_purge_frees_quota`. (Beat `trash_purge` scheduled in §15; wired in P9/P10.)
- [x] Second account cannot access first's docs by ID (proved by tests). → router-wide `test_isolation.py` (12 per-doc endpoints → 404 for other user).
- [x] Encrypted fixture opens with password, operations blocked with clear messaging. → ingest flags `is_encrypted`; ops → 423 `document_encrypted` (`test_encrypted_flagged_and_ops_blocked`); workspace password dialog + locked banner.
- Range/streaming: `test_content.py` — 200 full, 206 partial, 304 If-None-Match, 416 invalid; thumbnail cache hit from storage.
- **e2e:** `phase-1.spec.ts` — upload 2 → open → thumbnail jump → find → rename → trash → restore. Green.

### Phase 0 — Foundation · ✅ Complete (2026-07-19)

**Acceptance criteria** (from phase-00-foundation.md):
- [x] Fresh clone + `./infra/up.sh` → all containers healthy, migrations applied, seed user works, URL table printed. → `up.sh` green; 11 services healthy; `/api/health/` = `{"status":"ok",...}`; seed uploads 4 sample docs.
- [x] Register + login from UI; refresh keeps session; logout works; `/app/**` redirects unauthenticated. → `AuthFacade` + JWT interceptor (401→refresh→retry→logout) + `authGuard`; `test_auth.py`; e2e `phase-0.spec.ts` (register→dashboard→logout→guard→login).
- [x] `GET /api/docs/` renders OpenAPI UI (auth/users/jobs/config/health). → drf-spectacular Swagger at `/api/docs/` (dev), schema at `/api/schema/`.
- [x] Demo job runs: API enqueues, worker executes, UI toast. → `POST /api/jobs/demo/` → `noop_sleep` on worker; dashboard "Run demo job" → success toast; `test_jobs.py`; e2e asserts toast.
- [x] Mailpit reachable; test email lands. → `send_test_email` command (locmem-tested `test_commands.py`); Mailpit at :8025.
- [x] `down/restart-all/reset/logs/test` scripts behave as specified. → all executable, `reset --yes` non-interactive, `test --e2e` runs the three suites.
- [x] 0.1 checklist outcomes recorded; pins committed. → Verified pins table above; requirements pinned.

## Decisions log

| Date | Decision | Rationale | Plan doc amended? |
|---|---|---|---|
| 2026-07-19 | Keep `python:3.14-slim`; no fallback to 3.13. | Full engine stack (PyMuPDF 1.28.0 cp310-abi3, pikepdf 10.10.0 cp314-abi3, ocrmypdf, pyHanko, reportlab, pdf2docx, pymupdf4llm) installs & imports cleanly on 3.14.6. Risk in phase-00 retired. | No |
| 2026-07-19 | `pymupdf4llm` pinned **1.28.0** (arch §2 said "latest"; draft req had non-existent 0.0.31). | Package realigned versioning to track PyMuPDF; 0.0.x line stops at 0.0.27, current tracks 1.28.0. P6 dep, installed now per scaffold item 5. | No (arch said "latest") |
| 2026-07-19 | `reportlab` pinned **4.4.4** not 5.0.x. | 5.0 is a brand-new major (arch flagged ⚠ "check changelog"); 4.4.4 is the stable line and only needed for P8 certificate PDFs. Revisit at P8. | No (arch flagged for check) |
| 2026-07-19 | simplejwt token blacklist app enabled (`ROTATE_REFRESH_TOKENS`+`BLACKLIST_AFTER_ROTATION`). | Matches §17 "rotate+blacklist" and enables real logout. | No |
| 2026-07-19 | Hermetic `config.settings.test` (filesystem storage + eager Celery + locmem email). | Golden/API tests must not require the storage/redis containers; keeps CI coverage gates runnable. Engine `storage.py` gains a filesystem backend alongside S3. | No (implementation detail) |
| 2026-07-19 | Added `Document.metadata` JSON field, populated at ingest. | Info popover (P1) needs author/subject/dates without re-downloading the blob per request. §9 permits field additions by amending the doc. | **Yes — arch §9 Document line amended.** |
| 2026-07-19 | Host ports parameterized in compose (`API_PORT`/`WEB_PORT`/`DB_PORT`/`MAILPIT_PORT`/`STORAGE_PORT`), defaults = plan values (8000/4200/5432/8025/8333). **This machine overrides API_PORT=8010, DB_PORT=15432** in `.env`. | Host already runs an unrelated Django app on :8000 and Postgres on :5432/:5433. A clean machine still gets 8000/4200 by default. Frontend→api path is internal (`api:8000`), unaffected. | No (env-only; .env.example documents the knobs). |
| 2026-07-19 | Postgres volume mounts at `/var/lib/postgresql` (not `/var/lib/postgresql/data`). | postgres:18 image rejects the old `/data` mount (new version-subdir layout); container exited(1) until remounted. | No (compose fix). |
| 2026-07-19 | Dropped `--poll 2000` from the web dev-server command. | On Docker Desktop (Mac) the poll watcher fires spurious rebuilds on the virtiofs mount that deadlock the esbuild+Tailwind-v4 pipeline (container OOM/exit 137). Without poll the server compiles once and serves stably; hot-reload is a Mac-only dev nicety, not required for e2e/acceptance. `ng build`/`ng serve` both hit the same deadlock only on *rebuild*, so a one-shot serve is unaffected. | No (compose fix). |
| 2026-07-19 | Upload "needs repair" signal = **damaged trailer/xref** (missing `startxref…%%EOF`), not just `pikepdf.open` failure. | Empirically qpdf AND mupdf silently reconstruct any recoverable PDF, so `pikepdf.open` only raises on truly-unrepairable files (fitz can't fix those either) — making the phase-01 "repair retry succeeds" flow untestable as literally worded. Trailer-terminator damage is the reliable "recovered-but-damaged" signal; repair re-saves a clean copy. Hard pikepdf failure that fitz *can* still open also → needs_repair. Implements the criterion's intent. | Phase-01 intent preserved; mechanism documented here. |

## Blockers

_(None yet.)_

## Human review queue

| Added | Item | Phase | GATE? | Resolved |
|---|---|---|---|---|
| 2026-07-19 | **Workspace & dashboard look-and-feel** — functional Tailwind UI, but visual polish (spacing, empty states, responsive breakpoints, brand) deserves a designer's eye. | 1–2 | No | ⬜ |
| 2026-07-19 | **Crop UX** — implemented as a margin dialog (trim %), not the draggable overlay-rectangle from phase-02. The overlay-layer primitive (`PageOverlayComponent`) is properly built in Phase 3; revisit crop to use it then. | 2 | No | ⬜ |
| 2026-07-19 | **web dev-server memory** — `ng serve` (esbuild + pdf.js + Tailwind oxide) can OOM on an 8 GB Docker VM under concurrent load; mitigated by `restart: unless-stopped` + a web-ready wait in `test.sh`. Consider raising Docker Desktop RAM, or precompiling Tailwind to static CSS, for smoother local dev. | 0 | No | ⬜ |
| 2026-07-19 | **Host port remap on this machine** — an unrelated app occupies :8000/:5432 here, so `.env` sets API_PORT=8010, DB_PORT=15432. A clean machine gets the plan's 8000/5432 defaults. Nothing to fix; just be aware when browsing the API directly. | 0 | No | ⬜ |

## Session log

_(Newest first.)_

**2026-07-19 — Session 1 (agent, Prompt 1: Phases 0–2) — COMPLETE**

- **Phases 0, 1, 2 all ✅** with evidence (sections above). Full stack builds & runs on a torn-down volume-wiped state.
- **Verification (green):** `./infra/reset.sh --yes && ./infra/up.sh && ./infra/test.sh --e2e` →
  backend **125 passed** (coverage: apps **91%**, pdf_engine **92%** — gates 85/90 met), frontend **9 passed** (Vitest),
  e2e **3 passed** (phase-0/1/2 Playwright happy-paths). ruff + mypy(loose) clean. `manage.py check` clean; migrations idempotent from zero.
- **Seeded demo user** (`admin@zenpdf.local` / `admin12345`) can register/login, upload, view, search, organize pages, merge/split, and revert versions through the UI (proven by e2e).
- **Commits:** foundation committed (`fdb6e95`); a final commit lands the frontend, e2e, and the infra fixes from this session.
- **Bugs found & fixed during verification:** (1) revert job wasn't tracked to completion in the workspace (only created) — now uses `JobsFacade.dispatch`; (2) `test.sh` backend step inherited dev settings (pytest-django env-var precedence) — now forces `config.settings.test`; (3) default doc list didn't hide trashed docs; (4) `engine_inspect.inspect` mis-call in OutlineView.
- **Environment adaptations (this host):** ports 8000/5432 taken by an external app → parameterized host ports, `.env` uses 8010/15432; postgres:18 volume remounted at `/var/lib/postgresql`; web `--poll` dropped + `restart: unless-stopped` (esbuild/pdf.js OOM under load). All in Decisions log.

**➡ Handoff — where Phase 3 begins:** Start at `development-plans/phase-03-annotations.md`. Phase 3 builds the **shared overlay layer** (`PageOverlayComponent`, arch §7) — the positioned div-stack over each rendered page reused by phases 4/5/7/8. The workspace already has the viewer, thumbnail rail, tool-panel scaffold, and organize grid to hang it on; the crop tool (currently a margin dialog) should be migrated onto the overlay primitive once built. Backend: add `annotate_batch` + `flatten` engine fns (`pdf_engine/engine/annotations.py`) and register in `pdf_engine/registry.py` (queue `default`); the operation pipeline, versioning, geometry (§8), and job UX are all in place and reusable. **Human review queue** has 4 non-blocking items to eyeball (workspace look-and-feel, crop UX, web dev-server memory, host port remap).

**2026-07-19 — Session 1 (agent, Prompt 1: Phases 0–2)**
- Preflight: git 2.50.1 (repo init'd), Docker 29.4.1 + Compose v5.1.3 (daemon healthy, 8.3 GB, linux/arm64), Node 25 host → scaffolding done via `node:24` container. No `django-angular-project-setup` skill installed locally; following arch §4/§6/§7 conventions verbatim.
- Built `infra/docker/api.Dockerfile` (py3.14-slim ARG-parameterized) → engine stack validated (scaffold item 5). One pin fix (pymupdf4llm). Import smoke test green.
- Scaffolded Angular 22 app via `node:24` (`ng new … --skip-install`); default runner = Vitest 4.
- Wrote Django config/settings (base/dev/prod/test), top-level URLs, core exception handler (error shape §6). Building out apps next.
- Note: Docker Desktop sits behind a flaky HTTP proxy (192.168.65.1:3128) — transient image-pull timeouts; retried with backoff.
