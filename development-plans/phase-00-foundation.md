# Phase 0 — Foundation

**Goal:** a running skeleton: monorepo per `django-angular-project-setup` skill, auth working end-to-end, the full Docker stack up with one command, and the async job framework in place — so every later phase only adds features, never infrastructure.

Depends on: nothing. Everything below lands in this phase.

> **⚠ Amended 2026-07-31 — the routing/guard parts of this phase are superseded by [Phase 2B](phase-02b-anonymous-access.md).** 01-architecture §7 and §21 remove the app-wide auth guard: `/app/doc/:id` must render for a guest. The `authGuard` on `/app/**` below is correct only as *originally built*; 2B narrows it to `accountGuard` on `/app/dashboard`, `/app/sign*`, `/app/settings`. Phase 0's ✅ status stands — this is a retrofit, not a reopening.

## 0.1 Scaffold-day verification checklist (do first, ~30 min)

Versions were verified 2026-07-19; re-check the ⚠ items before pinning:

1. `djangorestframework-simplejwt` — confirm Django 6.0 support (changelog/PyPI). If broken and no release fixes it: pin the maintained successor or fall back to Django 5.2.16 LTS (sanctioned fallback, no other plan changes).
2. `ngx-extended-pdf-viewer` 28.x — check which pdf.js it bundles; note it, don't fight it.
3. Angular 22 default unit-test runner — scaffold, run `ng test`, use whatever v22 ships.
4. Tailwind 4 + Angular current install steps (angular.dev guide).
5. `pip install` the whole backend requirements set into the Docker image and run `python -c "import fitz, pikepdf, ocrmypdf, pyhanko, reportlab"` — surface binary/wheel issues on day one (PyMuPDF/pikepdf ship manylinux wheels; OCRmyPDF needs apt `tesseract-ocr`, `ghostscript`, `unpaper`, `pngquant` in the worker image). While at it, refresh any pins that drifted since 2026-07-19 (nginx, django-filter, drf-spectacular, boto3).
6. SeaweedFS image — pin current stable tag; smoke-test boto3 put/get/head against it (path-style addressing: `AWS_S3_ADDRESSING_STYLE='path'` + `endpoint_url`).

Record outcomes in PROGRESS.md's "Verified pins" table (PROGRESS.md is the single status record).

## 0.2 Backend scaffold

Follow the skill exactly, with these deltas:

- `requirements/base.txt` pinned to the versions in 01-architecture §2 (skill's listed versions are outdated — use ours): Django 6.0.7, DRF 3.17.1, simplejwt (per 0.1), cors-headers 4.9.0, django-filter, python-decouple, drf-spectacular 0.30.0, celery[redis] 5.6.3, django-storages[boto3] 1.14.6, psycopg[binary], dj-database-url. `requirements/engine.txt` (installed in api+worker image): PyMuPDF 1.28.0, pikepdf 10.10.0, pypdf, ocrmypdf 17.8.1, pyHanko, reportlab 5.x, pdf2docx, pymupdf4llm, requests. `dev.txt`: pytest, pytest-django, factory-boy, ruff, mypy, django-stubs.
- Apps created now: `users`, `core`, `documents`, `jobs`, `pdf_engine`, `esign` (models arrive in their phases; apps + routing skeleton now so URLs/imports are stable).
- **users**: custom `User` per 01-architecture §9 (`USERNAME_FIELD='email'`) — created BEFORE first migrate (skill's #1 rule). Endpoints: `POST /api/users/register/` (email, password, display_name; AllowAny + throttle), `GET/PATCH /api/users/me/`, skill's `/api/auth/login|refresh|logout/`. Email uniqueness case-insensitive (citext or lower-index).
- **core**: global exception handler (error shape §6), throttle classes (§16), `GET /api/config/` (public: limits, feature flags, ads off), `GET /api/health/` (checks db + redis + storage + gotenberg reachability; used by up.sh wait loop).
- **jobs**: `Job` model (§9), `GET /api/jobs/{id}/`, `GET /api/jobs/?status=&document=`, `POST /api/jobs/{id}/cancel/`. Celery app in `config/celery.py`, queues + beat config (§12, §15 — beat entries added as their phases land). A demo `noop_sleep` task type (removed in phase 1) proves the pipeline: enqueue → poll → succeeded.
- **pdf_engine**: package layout `engine/` (empty function stubs per registry §10 raise `NotImplementedError`), `schemas/` (JSON Schema per op — stubs), `geometry.py` (§8 — implemented + tested NOW: it's pure math), `storage.py` (boto3 client factory: internal + public endpoints), `exceptions.py` (EngineError taxonomy → job error codes).
- Settings split per skill; storage settings via decouple; `SPECTACULAR_SETTINGS` with title/version; logging: JSON-ish structured console.
- Management commands: `init_storage` (create bucket idempotently), `seed_dev` (admin user + 3 sample PDFs from fixtures).

## 0.3 Frontend scaffold

- `npx @angular/cli@22 new zenpdf-web --style=scss --directory frontend`, Tailwind 4 per current guide, ESLint (`ng add @angular/eslint`).
- 3-layer skeleton per skill: `core/` (models, `api.service.ts` base + `auth.service.ts`, `jobs.service.ts`; `auth.interceptor.ts` with 401→refresh→retry→logout; `auth.guard.ts`), `abstraction/` (`auth.facade.ts`, `jobs.facade.ts` with polling per §7), `features/` (`landing` (minimal public page), `auth/login`, `auth/register`, `app-shell` (topbar, nav, router-outlet), `dashboard` (empty state)), `shared/` (button, dialog service, toast service, spinner, empty-state).
- Routing per §7 with `authGuard` on `/app/**`; `environment.ts` per skill (`apiUrl: 'http://localhost:8000/api'` dev — or proxy.conf and relative `/api`; pick proxy.conf: fewer CORS surprises, matches prod nginx shape).
- Skill adaptation notes applied: no `standalone: true` flags needed, OnPush arrives by default, control flow `@if/@for`, signals in facades only.

## 0.4 Infra

Everything in 01-architecture §5, concretely:

- `infra/docker/api.Dockerfile`: multi-stage — base `python:3.14-slim` + apt (`tesseract-ocr` + language packs, `ghostscript`, `unpaper`, `pngquant`; LibreOffice deliberately NOT installed here — it lives only in the Gotenberg container) + requirements layers; `dev` target runs `runserver`; `prod` target runs `gunicorn`. Worker uses the same image (different command) — one image to build.
- `infra/docker/web.Dockerfile`: dev target = node:24 + `ng serve --host 0.0.0.0 --poll 2000`; prod target = build + nginx stable-alpine per skill (pin per architecture §2 ⚠).
- `infra/docker-compose.yml`: services table §5, healthchecks (db `pg_isready`, api `/api/health/`, storage S3 list, mailpit), named volumes (pgdata, seaweed-data, node_modules cache), single network. `infra/seaweedfs/s3-config.json`: static identity zenpdf/zenpdf-secret-dev with full actions on bucket.
- Scripts (all `set -euo pipefail`, runnable from anywhere via `cd "$(dirname "$0")"`): `up.sh`, `down.sh`, `restart-all.sh`, `reset.sh` (confirm prompt; `--yes` bypass), `logs.sh [svc]`, `test.sh [--e2e]`, `seed.sh` — behaviors per §5. `up.sh` ends by printing: app http://localhost:4200 · API http://localhost:8000/api · API docs /api/docs · Mailpit http://localhost:8025 · seeded login.
- `infra/docker-compose.prod.yml`: nginx web (skill's prod pattern), gunicorn api, workers, beat — same images, prod targets. Railway deployment intentionally deferred to phase 10 (use `railway-deployment` skill then).
- Dev signing cert generation in `up.sh` (openssl → PKCS#12) — consumed in phase 8 but created now so `.env` is complete from day one.

## 0.5 Tests (this phase)

Backend: register→login→refresh→me flow; wrong-password/dupe-email; health endpoint degrades correctly (stop storage container → health reports it); job pipeline with `noop_sleep` (enqueue, poll to succeeded, cancel while queued); geometry.py exhaustive rotation tests; error-shape contract test. Frontend: auth facade unit tests (login success/failure, token persistence, guard redirect); jobs facade polling test (fake timers). E2E (Playwright): register → login → land on empty dashboard.

## Acceptance criteria

- [ ] Fresh clone + `./infra/up.sh` on a clean machine → all containers healthy, migrations applied, seed user works, URL table printed. Total time under ~10 min on first build.
- [ ] Register + login from the UI; refresh keeps session; logout works; `/app/**` redirects unauthenticated users. **⚠ Superseded by Phase 2B** — after 2B the correct assertion is that only `/app/dashboard`, `/app/sign*` and `/app/settings` redirect, and `/app/doc/:id` renders for a guest. Do not re-tick this criterion as written.
- [ ] `GET /api/docs/` renders the OpenAPI UI listing auth/users/jobs/config/health.
- [ ] Demo job runs: API enqueues, worker executes, UI toast on completion (temporary dev button on dashboard).
- [ ] Mailpit UI reachable; a test email (management command) lands in it.
- [ ] `down.sh`, `restart-all.sh`, `reset.sh`, `logs.sh`, `test.sh` all behave as specified.
- [ ] 0.1 checklist outcomes recorded; all pins committed.

## Risks

- Dependency friction on Python 3.14 (fresh ecosystem): if any engine lib lacks 3.14 wheels, drop image to `python:3.13-slim` (both supported by Django 6.0) — record in PROGRESS.md Decisions log.
- simplejwt × Django 6 (covered by 0.1.1 with LTS fallback).

---

**Executed** (see PROGRESS.md §Phase 0). Known drifts between this work order and what shipped are recorded in PROGRESS's
Decisions log; this file is the plan, not the record.
