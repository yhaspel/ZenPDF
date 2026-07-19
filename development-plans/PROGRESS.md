# ZenPDF — Progress Tracker (canonical)

This file is the **single source of truth for execution status**. Every agent session working on ZenPDF must read it first and update it continuously. The phase docs define *what* to build; this file records *what actually happened*.

## Status overview

| Phase | Doc | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| 0 — Foundation | [phase-00-foundation.md](phase-00-foundation.md) | 🔵 In progress | 2026-07-19 | — | Scaffold + pins verified |
| 1 — Documents & viewer | [phase-01-documents-and-viewer.md](phase-01-documents-and-viewer.md) | ⬜ Not started | — | — | |
| 2 — Page organization | [phase-02-page-organization.md](phase-02-page-organization.md) | ⬜ Not started | — | — | |
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
| ngx-extended-pdf-viewer bundled pdf.js | Pending frontend install — viewer 28.1.x wraps pdfjs-dist 6.x (arch §2); exact bundled minor recorded when web image builds. | 2026-07-19 |
| Angular 22 default test runner | ✅ **Vitest 4** (`@angular/build:unit-test` builder + jsdom 28). Karma is gone in v22. TS ~6.0. | 2026-07-19 |
| Tailwind 4 install path | Pending — will follow angular.dev Tailwind v4 guide (`@tailwindcss/postcss` + `@import "tailwindcss"` in styles.scss). | 2026-07-19 |
| Engine imports on python:3.14-slim | ✅ python 3.14.6. `import fitz, pikepdf(10.10.0), ocrmypdf(17.8.1), pyhanko, reportlab, pdf2docx, pymupdf4llm` all OK. Binaries: tesseract 5.5.0, gs 10.05.1, unpaper, pngquant, qpdf present. **No 3.13 fallback needed.** | 2026-07-19 |
| SeaweedFS tag + boto3 smoke test | Pending compose bring-up (`init_storage` + upload tests exercise boto3 path-style put/get/head). | 2026-07-19 |
| Drifted pins refreshed (nginx, django-filter, drf-spectacular, boto3) | django-filter 25.2, drf-spectacular 0.30.0, boto3 1.40.0 pinned; nginx `stable-alpine` pinned at compose. reportlab pinned 4.4.4 (5.0 major deferred — see Decisions). | 2026-07-19 |

## Phase sections

_(Created by the executing agent per protocol step 2. Keep newest phase at top.)_

### Phase 0 — Foundation · 🔵 In progress (started 2026-07-19)

**Acceptance criteria** (from phase-00-foundation.md):
- [ ] Fresh clone + `./infra/up.sh` → all containers healthy, migrations applied, seed user works, URL table printed (<~10 min first build).
- [ ] Register + login from the UI; refresh keeps session; logout works; `/app/**` redirects unauthenticated users.
- [ ] `GET /api/docs/` renders OpenAPI UI listing auth/users/jobs/config/health.
- [ ] Demo job runs: API enqueues, worker executes, UI toast on completion (dev button on dashboard).
- [ ] Mailpit UI reachable; test email (management command) lands in it.
- [ ] `down.sh`, `restart-all.sh`, `reset.sh`, `logs.sh`, `test.sh` behave as specified.
- [ ] 0.1 checklist outcomes recorded; all pins committed.

**Evidence log:** (filled as criteria are met)
- Scaffold-day pins: recorded in Verified pins table above (engine stack on py3.14.6 ✅, Vitest runner ✅, simplejwt×Dj6 ✅).

## Decisions log

| Date | Decision | Rationale | Plan doc amended? |
|---|---|---|---|
| 2026-07-19 | Keep `python:3.14-slim`; no fallback to 3.13. | Full engine stack (PyMuPDF 1.28.0 cp310-abi3, pikepdf 10.10.0 cp314-abi3, ocrmypdf, pyHanko, reportlab, pdf2docx, pymupdf4llm) installs & imports cleanly on 3.14.6. Risk in phase-00 retired. | No |
| 2026-07-19 | `pymupdf4llm` pinned **1.28.0** (arch §2 said "latest"; draft req had non-existent 0.0.31). | Package realigned versioning to track PyMuPDF; 0.0.x line stops at 0.0.27, current tracks 1.28.0. P6 dep, installed now per scaffold item 5. | No (arch said "latest") |
| 2026-07-19 | `reportlab` pinned **4.4.4** not 5.0.x. | 5.0 is a brand-new major (arch flagged ⚠ "check changelog"); 4.4.4 is the stable line and only needed for P8 certificate PDFs. Revisit at P8. | No (arch flagged for check) |
| 2026-07-19 | simplejwt token blacklist app enabled (`ROTATE_REFRESH_TOKENS`+`BLACKLIST_AFTER_ROTATION`). | Matches §17 "rotate+blacklist" and enables real logout. | No |
| 2026-07-19 | Hermetic `config.settings.test` (filesystem storage + eager Celery + locmem email). | Golden/API tests must not require the storage/redis containers; keeps CI coverage gates runnable. Engine `storage.py` gains a filesystem backend alongside S3. | No (implementation detail) |
| 2026-07-19 | Added `Document.metadata` JSON field, populated at ingest. | Info popover (P1) needs author/subject/dates without re-downloading the blob per request. §9 permits field additions by amending the doc. | **Yes — arch §9 Document line amended.** |
| 2026-07-19 | Upload "needs repair" signal = **damaged trailer/xref** (missing `startxref…%%EOF`), not just `pikepdf.open` failure. | Empirically qpdf AND mupdf silently reconstruct any recoverable PDF, so `pikepdf.open` only raises on truly-unrepairable files (fitz can't fix those either) — making the phase-01 "repair retry succeeds" flow untestable as literally worded. Trailer-terminator damage is the reliable "recovered-but-damaged" signal; repair re-saves a clean copy. Hard pikepdf failure that fitz *can* still open also → needs_repair. Implements the criterion's intent. | Phase-01 intent preserved; mechanism documented here. |

## Blockers

_(None yet.)_

## Human review queue

| Added | Item | Phase | GATE? | Resolved |
|---|---|---|---|---|

## Session log

_(Newest first.)_

**2026-07-19 — Session 1 (agent, Prompt 1: Phases 0–2)**
- Preflight: git 2.50.1 (repo init'd), Docker 29.4.1 + Compose v5.1.3 (daemon healthy, 8.3 GB, linux/arm64), Node 25 host → scaffolding done via `node:24` container. No `django-angular-project-setup` skill installed locally; following arch §4/§6/§7 conventions verbatim.
- Built `infra/docker/api.Dockerfile` (py3.14-slim ARG-parameterized) → engine stack validated (scaffold item 5). One pin fix (pymupdf4llm). Import smoke test green.
- Scaffolded Angular 22 app via `node:24` (`ng new … --skip-install`); default runner = Vitest 4.
- Wrote Django config/settings (base/dev/prod/test), top-level URLs, core exception handler (error shape §6). Building out apps next.
- Note: Docker Desktop sits behind a flaky HTTP proxy (192.168.65.1:3128) — transient image-pull timeouts; retried with backoff.
