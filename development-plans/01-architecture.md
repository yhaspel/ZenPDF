# 01 — Architecture (Canonical Reference)

This document is normative for all phases. Phase docs reference it and do not restate it.

## 1. Product definition

ZenPDF: a free, ad-supported, multi-user web app. A user signs up, uploads PDFs into a private workspace, and works on them in **one integrated workspace** (viewer + tool panels): organize pages, annotate, edit content, fill/create forms, OCR, convert, secure, redact, and sign — including sending documents to external parties for legally sound e-signature. All processing is server-side on open-source engines; documents never leave the operator's infrastructure.

Personas: (a) registered user — full workspace; (b) external signer — no account, reaches a tokenized public signing page.

## 2. Stack (verified 2026-07-19)

| Component | Version | License | Role |
|---|---|---|---|
| Angular | **22.0.x** | MIT | SPA. Zoneless (default since v21), OnPush default, standalone, signals |
| Node.js | 24 LTS | MIT | Frontend toolchain + web dev container |
| ngx-extended-pdf-viewer | 28.1.x | Apache-2.0 | PDF viewer component (wraps PDF.js) — supports Angular 19–22 |
| pdfjs-dist | 6.1.x (as bundled by viewer ⚠) | Apache-2.0 | Rendering, text layer, search |
| Tailwind CSS | 4.x ⚠ | MIT | Styling (v4 setup differs from v3 — follow current angular+tailwind guide) |
| @angular/cdk | 22.x | MIT | Drag-drop (page reorder), overlays, a11y helpers |
| signature_pad | 5.1.x | MIT | Signature drawing canvas |
| Django | **6.0.7** | BSD | API framework (5.2.16 LTS is the sanctioned fallback if a dep blocks 6.0) |
| Python | 3.14.x (`python:3.14-slim`) | PSF | Backend runtime |
| djangorestframework | 3.17.1 | BSD | REST (officially supports Django 6.0) |
| djangorestframework-simplejwt | 5.5.1 ⚠ | MIT | JWT auth (verify Django 6.0 compat on scaffold day) |
| django-cors-headers | 4.9.0 | MIT | CORS (dev) |
| drf-spectacular | 0.30.0 | BSD | OpenAPI schema + docs UI |
| django-storages + boto3 | 1.14.6 / latest | BSD/Apache | S3 storage client |
| django-filter | latest ⚠ | BSD | List filtering (skill convention) |
| python-decouple | 3.8 | MIT | Env config (skill convention) |
| Celery | 5.6.3 | BSD | Async jobs |
| Redis | 8.x (`redis:8-alpine`) | AGPL (accepted; Valkey 8 BSD is drop-in) | Broker, result backend, locks, throttle counters |
| PostgreSQL | 18 (`postgres:18-alpine`) | PostgreSQL | Database |
| PyMuPDF | 1.28.0 | **AGPL-3.0** (accepted) | Core engine: render, extract, redact, edit, annotate, forms |
| pikepdf | 10.10.0 | MPL-2.0 | Encryption, permissions, repair, linearize, low-level page ops |
| pypdf | 6.14.2 | BSD | Utility fallback |
| OCRmyPDF (+Tesseract 5.5, Ghostscript) | 17.8.1 | MPL-2.0 (Tess Apache-2.0, GS **AGPL** accepted) | OCR, PDF/A |
| pyHanko | 0.35.2 | MIT | PAdES signatures, RFC 3161 timestamps, validation |
| pdf2docx | latest | MIT (archived but functional) | PDF→Word |
| pymupdf4llm | latest | AGPL (accepted) | PDF→Markdown export |
| reportlab | 5.0.x ⚠ (new major — check changelog) | BSD | Certificate-of-completion PDF |
| Gotenberg | 8.34 (`gotenberg/gotenberg:8`) | MIT | Office/HTML/URL→PDF (LibreOffice + Chromium) |
| SeaweedFS | `chrislusf/seaweedfs` pinned ⚠ | Apache-2.0 | Local S3-compatible object store (MinIO is archived/dead) |
| Mailpit | `axllent/mailpit` v1.30 | MIT | Local SMTP capture + web UI |
| nginx | stable-alpine ⚠ (pin current at scaffold) | BSD | Prod static serving + /api proxy (skill convention) |

⚠ = re-verify exact pin on scaffold day (phase 0 checklist). **Licensing decision record:** AGPL components (PyMuPDF, Ghostscript, Redis 8, pymupdf4llm) approved by owner 2026-07-19. All PDF-engine calls go through `backend/apps/pdf_engine/` exclusively, so a future license strategy change swaps one module, not the app.

## 3. System architecture

```
Browser (Angular SPA + public signing pages)
   │ HTTPS  (dev: :4200 → proxy /api → :8000 ; prod: nginx serves SPA, proxies /api)
   ▼
Django API (DRF, JWT)  ──────────────┐
   │            │                    │ enqueue
   ▼            ▼                    ▼
PostgreSQL   Object storage      Redis ◄── Celery workers (queues: default | heavy | render)
(metadata,   (SeaweedFS S3:          │         │  PyMuPDF · pikepdf · OCRmyPDF · pyHanko · reportlab
 audit)       doc versions,          │         ├──► Gotenberg (HTTP) — Office/HTML→PDF
              thumbs, exports)       │         └──► SMTP (Mailpit dev) — sign-request mail
                                 Celery beat (reminders, expiry, GC)
```

Service responsibilities: the API never runs PDF processing in-request — every mutation is a Job on Celery. Two bounded exceptions: the upload-time validation probe (pikepdf open + metadata, §17) and single-page thumbnail renders on cache miss (<1 s budget, §13). Workers are stateless; all artifacts go to object storage; Postgres holds metadata + audit.

## 4. Monorepo layout (extends `django-angular-project-setup` skill)

```
ZenPDF/
├── backend/
│   ├── apps/
│   │   ├── users/          # custom User (email login), registration, profile, usage
│   │   ├── core/           # shared: error handling, throttles, config endpoint, UsageCounter
│   │   ├── documents/      # Document, DocumentVersion, Folder, upload/content/thumbnails/search
│   │   ├── jobs/           # Job model, polling API, celery app glue
│   │   ├── pdf_engine/     # NO models. Pure engine functions + per-op param schemas (the only
│   │   │                   #   module importing fitz/pikepdf/ocrmypdf/pyhanko/gotenberg client)
│   │   └── esign/          # SavedSignature, SignRequest, Recipient, SignField, AuditEvent, public API
│   ├── config/settings/{base,dev,prod}.py · config/{urls,wsgi,celery}.py
│   ├── requirements/{base,dev,prod}.txt
│   ├── tests/fixtures/pdfs/   # golden test corpus (see §18)
│   └── manage.py
├── frontend/
│   └── src/app/
│       ├── core/           # models/, services/ (pure HTTP), guards/, interceptors/
│       ├── abstraction/    # facades (signal state): auth, documents, viewer, jobs, tools, esign…
│       ├── features/       # auth, dashboard, workspace (viewer+tool panels), sign (wizard +
│       │                   #   public /s/:token ceremony), settings, legal (privacy/terms), landing
│       └── shared/         # dumb reusable UI (buttons, dialogs, upload dropzone, ad-slot)
├── infra/
│   ├── docker-compose.yml            # full dev stack (see §5)
│   ├── docker-compose.prod.yml       # prod-shaped: nginx web, gunicorn api, workers
│   ├── docker/{api.Dockerfile, web.Dockerfile, worker.Dockerfile→(api image), nginx.conf}
│   ├── seaweedfs/s3-config.json      # static S3 credentials (dev)
│   ├── certs/                        # dev signing cert (.p12) — generated by up.sh, gitignored
│   ├── .env.example → .env
│   └── up.sh · down.sh · restart-all.sh · logs.sh · reset.sh · test.sh · seed.sh
├── e2e/                    # Playwright suite (runs against the compose stack)
└── development-plans/      # this plan
```

Deviation from skill: the skill's `docker/` folder lives inside `infra/` (owner requirement: all infra + lifecycle scripts under `infra/`). Everything else (settings split, custom user first, JWT endpoints, 3-layer frontend, nginx prod proxy, `environment.ts` pattern) follows the skill.

## 5. Local dev stack (docker-compose services)

| Service | Image | Ports (host) | Notes |
|---|---|---|---|
| web | node:24 (volume-mounted `ng serve --host 0.0.0.0`) | 4200 | proxy.conf routes /api→api:8000 |
| api | infra/docker/api.Dockerfile (dev target, runserver, volume-mounted) | 8000 | autoreload |
| worker-default / worker-heavy / worker-render | api image, `celery -A config -Q <queue>` | — | see §12 limits |
| beat | api image, `celery -A config beat` | — | schedule §15 |
| db | postgres:18-alpine | 5432 | volume pgdata |
| redis | redis:8-alpine | — | internal only |
| storage | chrislusf/seaweedfs `server -s3 -dir=/data -s3.config=/etc/seaweedfs/s3-config.json -ip.bind=0.0.0.0` | 8333 | volume seaweed-data; static creds |
| gotenberg | gotenberg/gotenberg:8 | — | internal only |
| mailpit | axllent/mailpit | 8025 (UI) | SMTP :1025 internal |

`up.sh` (single command, idempotent): check docker; copy `.env.example`→`.env` if missing; generate dev signing cert into `infra/certs/` if missing (openssl self-signed → .p12); `docker compose up -d --build`; wait for db/api health; `manage.py migrate`; `manage.py init_storage` (create bucket via boto3); `manage.py seed_dev` (admin user admin@zenpdf.local / from .env, demo PDFs); print URL table (app 4200, api 8000, api docs /api/docs, mailpit 8025). `down.sh` = compose down. `restart-all.sh` = down + up (no volume wipe). `reset.sh` = down -v + up (destructive; confirm prompt, skippable via `--yes` for non-interactive/agent/CI use). `logs.sh [service]` = compose logs -f. `test.sh` = backend pytest + frontend unit + optional `--e2e` Playwright. `seed.sh` = rerun seeding.

## 6. Backend conventions

- Settings per skill (`base/dev/prod`), `AUTH_USER_MODEL='users.User'` **before first migrate**. `USERNAME_FIELD='email'` (login by email; `display_name` optional).
- DRF: JWT default auth, `IsAuthenticated` default, LimitOffset pagination (default 50, max 200), django-filter backend.
- **Error shape (all non-2xx):** `{"error": {"code": "<machine_code>", "message": "<human>", "details": {…}}}`. Implemented via a global DRF exception handler in `apps/core`. Key codes: `validation_error`, `not_found`, `version_conflict` (409), `quota_exceeded` (429), `throttled` (429), `file_too_large` (413), `unsupported_file` (415), `document_encrypted` (423), `token_invalid` (401 public sign), `token_expired` (410 public sign — expired/completed/canceled requests).
- IDs are UUIDv4. All timestamps UTC ISO-8601. All list endpoints filterable/sortable via query params.
- OpenAPI: drf-spectacular; schema at `/api/schema/`, Swagger UI `/api/docs/` (dev-only). Every endpoint annotated; the schema is part of each phase's DoD.
- URL map (top level): `/api/auth/*` (skill), `/api/users/*`, `/api/config/` (public: feature flags, limits, ads client id), `/api/folders/`, `/api/documents/…`, `/api/operations/` (cross-document ops), `/api/jobs/…`, `/api/signatures/`, `/api/sign-requests/…`, `/api/public/sign/{token}/…` (AllowAny + throttle), `/api/verify/` (signature verification), `/api/health/`.

## 7. Frontend conventions (Angular 22)

- 3-layer per skill: **core** services are pure/stateless HTTP; **facades** own `signal()` state and orchestration; **features** are dumb OnPush components injecting facades. No NgModules; `@if/@for` control flow; zoneless — never rely on zone-based hacks; DOM work outside Angular only inside the viewer wrapper.
- Skill's v19 snippets adapt to v22: `standalone: true` is implicit; OnPush is scaffolded by default; Signal Forms may be used for new forms (stable in v22) but Reactive Forms are acceptable — pick one per feature, don't mix within a component.
- Routes: `/` landing (public) · `/auth/login|register` · `/app` (authed shell): `/app/dashboard`, `/app/doc/:id` (workspace), `/app/sign` (requests list) + `/app/sign/new/:docId` (wizard), `/app/settings` · `/s/:token` (public signing ceremony) · `/verify` (public) · `/legal/privacy|terms|esign-disclosure`.
- Workspace shell = viewer (ngx-extended-pdf-viewer) + left thumbnail rail + right tool panel (routed tool tabs) + **overlay layer** component: a positioned div stack over each rendered page for placement interactions (annotations, fields, redaction boxes, whiteout, crop, signatures). Built once in phase 3, reused by 4/5/7/8.
- JWT in localStorage + interceptor per skill (tradeoff noted; CSP mitigations in phase 10). 401 → refresh flow → logout on failure.
- Jobs UX: a single `JobsFacade` polls active jobs (500 ms ×6, then 1 s; stop on terminal state), exposes per-job progress signals; global toast on success/failure; document reload on new version.

## 8. Coordinate system (critical, used by every placement feature)

Client sends geometry as **normalized page coordinates in visual space**: origin top-left of the page *as displayed* (rotation applied), `x,y,w,h ∈ [0,1]` relative to displayed page width/height, plus `page` (0-based). PyMuPDF's page coordinate space is also top-left-origin with rotation applied, so server mapping is `fitz.Rect(x*W, y*H, (x+w)*W, (y+h)*H)` with `W,H = page.rect.width,.height`. The engine converts to PDF-native bottom-left space only where a library requires it (pyHanko visible-signature boxes). One utility: `pdf_engine/geometry.py` — the only place conversions live, with exhaustive tests for rotated pages (0/90/180/270).

## 9. Data model (canonical — phases may add fields only by amending this doc)

**users.User**(AbstractUser): email unique (login), display_name, email_verified bool, accepted_tos_at datetime null, storage_bytes_used bigint (denormalized).
**core.UsageCounter**: user FK, period "YYYY-MM", sign_requests int, ocr_pages int, conversions int; unique(user, period).
**core.EmailSuppression**: email unique, reason ∈ {complaint, unsubscribe, bounce, manual}, created_at — honored by all outbound mail (phase 9).
**documents.Folder**: id, owner FK, parent FK null, name; unique(owner, parent, name).
**documents.Document**: id, owner FK, folder FK null, title, status ∈ {ready, processing, error}, page_count, size_bytes, is_encrypted bool, starred bool, metadata JSON (author/subject/keywords/dates, populated at ingest — amended 2026-07-19, P1), current_version FK→DocumentVersion null, error_message, last_opened_at, trashed_at null, created_at, updated_at.
**documents.DocumentVersion**: id, document FK (`versions`), seq int (unique per document, starts 1), storage_key, size_bytes, page_count, sha256, label (e.g. "Original", "OCR", "Signed"), created_by FK user null, job FK null, created_at. Immutable.
**jobs.Job**: id, user FK, document FK null, type (operation type, §10), params JSON, base_version_seq int null, status ∈ {queued, running, succeeded, failed, canceled}, progress 0–100, error_code, error_message, result JSON null, celery_task_id, created_at, started_at, finished_at.
**esign.SavedSignature**: id, user FK, kind ∈ {signature, initials}, method ∈ {draw, type, upload}, storage_key (PNG, alpha), typed_text, font, is_default, created_at.
**esign.SignRequest**: id, owner FK, document FK, source_version FK, title, message, status ∈ {draft, sent, completed, declined, expired, canceled}, envelope_code (human-short, stamped on pages, e.g. `ZEN-8F3KQ2`), expires_at, reminder_every_days int=3, sent_at, completed_at, final_key, certificate_key, final_sha256, created_at.
**esign.Recipient**: id, sign_request FK (`recipients`), email, name, role ∈ {signer, approver, viewer, cc}, order int=1 (same order ⇒ parallel group; groups proceed in ascending order), status ∈ {pending, notified, viewed, consented, completed, declined}, token (urlsafe 43ch, unique), consent_at/ip/user_agent, decline_reason, last_notified_at, completed_at.
**esign.SignField**: id, sign_request FK, recipient FK, page int, x/y/w/h floats (§8), type ∈ {signature, initials, date_signed, text, checkbox}, required bool=true, label, value, filled_at.
**esign.AuditEvent**: id, sign_request FK (`audit_events`), recipient FK null, type (created|sent|opened|consented|field_filled|signed|approved|declined|reminder_sent|expired|canceled|completed|seal_applied|downloaded), created_at, ip, user_agent, metadata JSON, prev_hash, event_hash = sha256(prev_hash + canonical_json({type, created_at, recipient_id, ip, user_agent, metadata})). Append-only (no update/delete paths; enforced in model + DB permissions in prod).

## 10. Operation registry

All document mutations/derivations run as Jobs with `type` from this registry. Params are validated against per-type JSON Schemas living in `pdf_engine/schemas/` (shared with OpenAPI docs). Engine column = primary library.

| type | Phase | Engine | Params (summary) |
|---|---|---|---|
| rotate_pages | 2 | PyMuPDF | pages[], degrees ∈ {90,180,270} |
| delete_pages / duplicate_pages / reorder_pages | 2 | PyMuPDF | pages[] / pages[] / new_order[] |
| extract_pages | 2 | PyMuPDF | pages[], as_new_document bool |
| insert_blank | 2 | PyMuPDF | at_index, count, size |
| insert_from_document | 2 | PyMuPDF | source_document_id, source_pages[], at_index |
| split | 2 | PyMuPDF | mode ∈ {ranges, every_n, by_size_mb, by_bookmarks}, args → result: new documents |
| merge | 2 | PyMuPDF | document_ids[] (ordered) → new document |
| alternate_mix | 2 | PyMuPDF | document_a, document_b, reverse_b bool → new document |
| nup | 2 | PyMuPDF | per_sheet ∈ {2,4}, page_size |
| crop_pages | 2 | PyMuPDF | pages[], rect (§8) |
| scale_pages | 2 | PyMuPDF | pages[], target_size |
| compress | 2 | PyMuPDF | preset ∈ {light, balanced, strong}, image_dpi |
| annotate_batch | 3 | PyMuPDF | ops[] add/update/delete of annotation objects (per-type schemas) |
| flatten | 3/5 | PyMuPDF | what ∈ {annotations, form, all} |
| edit_text | 4 | PyMuPDF | edits[]: {page, block_bbox, new_text, font_family, size, color, align} (redact+reinsert) |
| add_text / whiteout | 4 | PyMuPDF | boxes[] w/ style / rects[] |
| find_replace | 4 | PyMuPDF | find, replace, match_case, pages?, dry_run bool, only[] (match ids) → result: matches/count |
| add_image / replace_image / delete_image | 4 | PyMuPDF | upload ref or image xref + rect |
| add_link / edit_link / delete_link | 4 | PyMuPDF | rect + uri/page target |
| header_footer | 4 | PyMuPDF | segments (left/center/right × header/footer), tokens {page}, {total}, {date}, range, style |
| page_numbers | 4 | PyMuPDF | position, format, start_at, range, style |
| watermark | 4 | PyMuPDF | text|image, opacity, rotation, scale, tiling, range |
| bates | 4 | PyMuPDF | prefix, suffix, start, digits, position, range |
| overlay_pdf | 4 | PyMuPDF | overlay_document_id, mode ∈ {foreground, background}, range |
| set_metadata | 4 | PyMuPDF | title/author/subject/keywords (+clear flag) |
| set_bookmarks | 4 | PyMuPDF | toc[] (nested) |
| fill_form | 5 | PyMuPDF | values {field_name: value}, flatten_after bool |
| edit_form_fields_batch | 5 | PyMuPDF (+pyHanko for signature fields) | ops[]: add/update/delete of field specs {type, name, rect §8, page, options…} |
| import_form_data | 5 | PyMuPDF | format ∈ {json, csv}, file ref |
| ocr | 6 | OCRmyPDF | languages[], deskew bool, rotate_pages bool, clean bool, force bool |
| convert_from | 6 | Gotenberg / PyMuPDF | source upload (docx/xlsx/pptx/odt/rtf/txt/img/html) or url → new document |
| convert_to | 6 | pdf2docx / PyMuPDF / pymupdf4llm / OCRmyPDF | target ∈ {docx, images(png/jpg+dpi), txt, md, html, pdfa} → export |
| repair | 6 | pikepdf | — |
| compare | 6 | PyMuPDF | other_document_id → export: diff report (JSON + rendered) |
| encrypt | 7 | pikepdf | user_password?, owner_password, permissions{} (AES-256) |
| decrypt | 7 | pikepdf | password |
| set_permissions | 7 | pikepdf | owner_password, permissions{} |
| redact | 7 | PyMuPDF | areas[] (§8), patterns[] {preset|regex}, search_text?, match_case, scope, fill, dry_run bool, fork_clean_copy bool |
| sanitize | 7 | PyMuPDF+pikepdf | strip ∈ {metadata, javascript, attachments, hidden_layers…} |
| self_sign | 8 | PyMuPDF | placements[]: {signature_id, page, rect §8}, include_date bool (always flattens) |
| finalize_sign_request | 8 (internal) | PyMuPDF+pyHanko+reportlab | sign_request_id (burn fields → seal → certificate) |
| generate_thumbnails (internal) | 1 | PyMuPDF | version, pages, width |
| revert_version | 1 | storage copy (no engine) | seq → new head version copied from v{seq} (§14) |

Version-producing ops → `result: {document_id, version_id, seq}` (split/merge/extract-as-new/convert_from → `{documents: [...]}`). Export ops → `result: {export_key, filename, content_type, size}` + `GET /api/jobs/{id}/download`.

## 11. Job pipeline

`POST /api/documents/{id}/operations/ {type, params, base_version_seq}` → validate schema + quota + doc ownership → create Job(queued) → dispatch to queue by type → **202** `{job}`. Cross-document ops use `POST /api/operations/`. Poll `GET /api/jobs/{id}/`. Cancel: `POST /api/jobs/{id}/cancel/` (revokes if still queued).

Worker algorithm (every mutation op): acquire Redis lock `zen:doc:{id}` (blocking, 120 s timeout) → refetch document → if `base_version_seq` ≠ `current_version.seq` → fail `version_conflict` → download blob → run engine fn (pure: bytes+params→bytes) → sha256, page count → upload `docs/{doc}/v{seq+1}.pdf` → create DocumentVersion → update Document (current_version, counts, sizes, status) → release lock → job succeeded. On any exception: job failed with sanitized error, document untouched (versions are immutable → no partial states, ever).

## 12. Queues & limits

| Queue | Ops | Concurrency | Soft/hard time limit |
|---|---|---|---|
| default | page ops (incl. split), annotate, forms, text/image edits, stamps, security (encrypt/decrypt/redact/sanitize), self_sign, revert_version | 4 | 60 s / 120 s |
| heavy | ocr, convert_*, compress, compare, merge, alternate_mix, repair, finalize_sign_request | 2 | 600 s / 900 s |
| render | generate_thumbnails, page renders | 4 | 30 s / 60 s |

Workers: prefork, `max_memory_per_child=1.5 GB`, non-root, open PDFs per-task (never share fitz objects across tasks/threads). Celery `task_acks_late=True` + idempotent tasks (version creation is guarded by unique (document, seq)).

## 13. Storage

Bucket `zenpdf`, all private. Keys: `docs/{document_id}/v{seq}.pdf` · `thumbs/{document_id}/{seq}/p{page}@{w}.png` · `sigs/{user_id}/{signature_id}.png` · `sign/{sign_request_id}/{final.pdf|certificate.pdf}` · `exports/{job_id}/{filename}` (TTL 24 h via beat GC).

**Delivery default = API proxy with HTTP Range support** (`GET /api/documents/{id}/content/?version=` streams; Range honored so PDF.js can chunk; `Cache-Control: private` + ETag=sha256). Rationale: avoids depending on SeaweedFS presign/CORS behavior locally. Optimization flag `PRESIGNED_DELIVERY=true` → 302 to presigned GET generated against `S3_PUBLIC_ENDPOINT` (browser-reachable host — signatures bind the host header; documented gotcha). Thumbnails: `GET /api/documents/{id}/pages/{n}/thumbnail/?w=240&version=` — proxied, long Cache-Control, rendered on demand + cached to storage. Uploads: multipart to API (streamed to storage; size-capped). Direct-to-storage presigned PUT = backlog optimization.

## 14. Versioning & undo

Every mutation ⇒ new immutable version; `Document.current_version` advances. History panel lists versions (label, op, time, size). **Undo = revert**: `POST /api/documents/{id}/versions/{seq}/revert/` copies that version's blob as a new head version labeled "Reverted to v{seq}". Retention: keep newest `VERSION_RETENTION` (default 50) + always v1 (Original) + any version referenced by a SignRequest; beat GC prunes blobs beyond retention.

## 15. Email & beat schedule

Django email → SMTP env (Mailpit in dev). HTML+text templates: sign invite, reminder, declined, completed (+links), email-verification. Beat: `sign_reminders` daily 08:00 UTC (pending recipients, every `reminder_every_days`, stop at expiry) · `sign_expirations` hourly · `trash_purge` daily (trashed >30 d) · `exports_purge` daily (>24 h) · `version_retention_gc` weekly · `usage_recompute` daily 02:00.

## 16. Quotas & throttles (defaults; enforced from phase 1, tightened in phase 9)

Per user: storage 2 GB (`USER_STORAGE_QUOTA_MB`), max upload 100 MB (`MAX_UPLOAD_MB`), max pages/doc 2000, active docs unlimited, sign requests 30/month, OCR 2000 pages/month, concurrent running jobs 3. DRF throttles: anon 30/min, authed 120/min, auth endpoints 10/min, public-sign endpoints 20/min/IP. All quota rejections use `quota_exceeded` with human-readable detail. `GET /api/users/me/usage/` reports consumption; `GET /api/config/` exposes limits to the UI.

## 17. Security model (summary — phase 10 hardens)

Upload validation: size cap → magic bytes `%PDF` → `pikepdf.open` parse (repair prompt on failure) → page cap → encrypted? mark `is_encrypted`, require password to operate (423). Workers: time/memory limits (§12), non-root, untrusted parsing confined to engine libs kept current. SSRF (url→pdf): scheme allowlist http/https + deny private/link-local IPs (resolve-then-check) before handing to Gotenberg. XSS: no `innerHTML` with document-derived text, Angular default escaping. Public sign tokens: 256-bit, single-purpose, expire with request, throttled. JWT per skill (rotate+blacklist). Audit chain append-only. Admin site disabled in prod (or IP-gated). CSP + security headers in prod nginx (phase 10). PDF JS-execution: PDF.js scripting stays disabled (default).

## 18. Testing strategy

Backend: pytest + pytest-django, `CELERY_TASK_ALWAYS_EAGER=True` for API tests; engine functions get **golden tests** against a fixture corpus (`tests/fixtures/pdfs/`: text.pdf, scanned.pdf (image-only), form.pdf (AcroForm), encrypted.pdf, rotated-90.pdf, unicode.pdf, corrupt.pdf, large-generated.pdf 500 pp) asserting page counts, extracted text, form values, encryption state — not byte-equality (PDF output nondeterminism). Coverage gate: apps 85%, pdf_engine 90%. Frontend: unit tests for every facade + core service (HttpTestingController); `ng test` with the v22 default runner ⚠. E2E: Playwright against the full compose stack (`infra/test.sh --e2e`), one happy-path spec per phase (see phase docs). CI note: any CI must run `ruff`, `mypy` (loose), `eslint`, backend tests, frontend tests.

## 19. Environment matrix (infra/.env.example)

```
# Django
SECRET_KEY=dev-change-me            DJANGO_SETTINGS_MODULE=config.settings.dev
DATABASE_URL=postgres://zen:zen@db:5432/zenpdf
REDIS_URL=redis://redis:6379/0
FRONTEND_BASE_URL=http://localhost:4200
# Storage
S3_ENDPOINT_URL=http://storage:8333       S3_PUBLIC_ENDPOINT=http://localhost:8333
S3_ACCESS_KEY=zenpdf                      S3_SECRET_KEY=zenpdf-secret-dev
S3_BUCKET=zenpdf                          PRESIGNED_DELIVERY=false
# Email
EMAIL_HOST=mailpit  EMAIL_PORT=1025  DEFAULT_FROM_EMAIL=ZenPDF <no-reply@zenpdf.local>
# Engine
GOTENBERG_URL=http://gotenberg:3000
SIGNING_CERT_PATH=/certs/zenpdf-dev.p12   SIGNING_CERT_PASSWORD=devpass
TSA_URL=            # empty ⇒ PAdES B-B in dev; set a public TSA for B-T
# Limits (see §16)
MAX_UPLOAD_MB=100  USER_STORAGE_QUOTA_MB=2048  MAX_PAGES=2000  VERSION_RETENTION=50
SIGN_REQUESTS_PER_MONTH=30  OCR_PAGES_PER_MONTH=2000
# Ads (phase 9)
ADS_ENABLED=false  ADSENSE_CLIENT_ID=
# Seed
SEED_ADMIN_EMAIL=admin@zenpdf.local  SEED_ADMIN_PASSWORD=admin12345
```

## 20. Definition of Done (every phase)

1. All acceptance criteria demonstrated on a fresh `./infra/up.sh` stack. 2. Migrations idempotent from zero. 3. Unit/integration tests green; coverage gates hold; new engine fns have golden tests. 4. Playwright happy-path for the phase green. 5. OpenAPI schema updated & accurate. 6. Lint clean (ruff, eslint). 7. No `TODO`/dead code introduced; feature flags documented. 8. `development-plans/PROGRESS.md` updated per its Update protocol (status, evidence, decisions).
