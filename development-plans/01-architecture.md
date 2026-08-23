# 01 — Architecture (Canonical Reference)

This document is normative for all phases. Phase docs reference it and do not restate it.

## 1. Product definition

ZenPDF: a free, ad-supported web app. A visitor lands on a tool page, drops in a PDF, and works on it immediately in **one integrated workspace** (viewer + tool panels) — **no account, no login, no email** — organizing pages, annotating, editing content, filling/creating forms, OCR, converting, securing, redacting, and signing. Creating an account is an *upgrade* (persistent library, higher limits, sending signature requests), never an entry fee. All processing is server-side on open-source engines; documents never leave the operator's infrastructure.

**Access model is anonymous-first — see §21, which is normative.** Monetization is advertising, and ad revenue scales with sessions, so any gate in front of a stateless tool is a direct tax on revenue. Accounts exist to capture users *after* value is delivered, not before.

Personas: (a) **guest** — no account, works in a session-scoped workspace with tighter limits and auto-expiring files; (b) **registered user** — persistent library, folders, higher limits, saved signatures, may send signature requests; (c) **external signer** — no account, reaches a tokenized public signing page.

## 2. Stack (verified 2026-07-19)

| Component | Version | License | Role |
|---|---|---|---|
| Angular | **22.0.x** | MIT | SPA. Zoneless (default since v21), OnPush default, standalone, signals |
| Node.js | 24 LTS | MIT | Frontend toolchain + web dev container |
| ngx-extended-pdf-viewer | 28.1.x | Apache-2.0 | PDF viewer component (wraps PDF.js) — supports Angular 19–22 |
| pdfjs-dist | 6.1.x (as bundled by viewer ⚠) | Apache-2.0 | Rendering, text layer, search |
| Tailwind CSS | 4.x ⚠ | MIT | Styling (v4 setup differs from v3 — follow current angular+tailwind guide) |
| @angular/cdk | 22.x | MIT | Drag-drop (page reorder), overlays, a11y helpers |
| ~~signature_pad~~ | — | — | **Not used** *(corrected 2026-08-22)*. Researched and never adopted; it is not in `frontend/package.json`. Signature drawing is pointer events on a plain `<canvas>` the app owns, which is also what made the typed-signature and keyboard paths the a11y work needed reachable without fighting a third party. |
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
| reportlab | **4.4.4** (pinned, `backend/requirements/engine.txt:8`) | BSD | Certificate-of-completion PDF. *Corrected 2026-08-22: this said 5.0.x. The 5.0 major was **deliberately deferred** on scaffold day and never taken — see PROGRESS's Verified pins and Decisions log.* |
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
│   ├── docker/{api.Dockerfile, web.Dockerfile}   # the workers run the api image
│   ├── railway/                      # the production deploy target (§ Deployment target)
│   │   ├── api.Dockerfile · web.Dockerfile
│   │   ├── nginx.railway.conf        # production's real security-header + MIME policy
│   │   └── gotenberg-deny-list.txt   # SSRF egress deny-list, drift-checked by test.sh
│   ├── perf/                         # profile-gated locust smoke (§10.2)
│   ├── seaweedfs/s3-config.json      # static S3 credentials (dev)
│   ├── certs/                        # dev signing cert (.p12) — generated by up.sh, gitignored
│   ├── .env.example → .env
│   └── up.sh · down.sh · restart-all.sh · logs.sh · reset.sh · test.sh · seed.sh
├── e2e/                    # Playwright suite (runs against the compose stack)
├── docs/
│   ├── ops/                # runbooks: deploy, rollback, restore-drill, queue-stuck,
│   │                       #   storage-full, secrets, cert-renewal, dependencies, release,
│   │                       #   railway*.md (the live target)
│   ├── design/             # design-instructions.md (the contract) + mockups/
│   ├── reviews/            # QA + status reviews, production audits, handoffs/ (+ TRACKING.md)
│   ├── archived/           # executed prompts and format-patch archives
│   └── user-guide.md · 09-*.md · 10-*.md   # user- and owner-facing docs
└── development-plans/      # this plan
```

*(§4 corrected 2026-08-22: it named `infra/docker/worker.Dockerfile` and `infra/docker/nginx.conf`, **neither of which has ever existed** — the workers run the api image, and the nginx policy lives at `frontend/nginx.conf` for compose and `infra/railway/nginx.railway.conf` for production. `infra/railway/`, `infra/perf/` and the whole of `docs/` were missing.)*

Deviation from skill: the skill's `docker/` folder lives inside `infra/` (owner requirement: all infra + lifecycle scripts under `infra/`). Everything else (settings split, custom user first, JWT endpoints, 3-layer frontend, nginx prod proxy, `environment.ts` pattern) follows the skill.

**Deployment target.** Production is **Railway**, live since 2026-08-08 at `https://zenpdf.up.railway.app`, auto-deploying from `main` since 08-10. Service-per-process mapping, variables, watch patterns and the operational procedures are in **`docs/ops/railway.md`**; the deploy evidence is `docs/ops/railway-deploy-report-2026-08-08.md`. `docker-compose.prod.yml` is kept as the portable prod-shaped stack and as what the local gate runs against — it is not what serves users.

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
- DRF: **dual authentication** — `PrincipalAuthentication` resolves a request to exactly one *principal*: a `User` (JWT, per skill) or a `GuestSession` (`X-Guest-Token` header, §21). Default permission is `IsPrincipal` (either identity satisfies it); endpoints that genuinely need an account declare `IsAccount` and return 403 `account_required`. LimitOffset pagination (default 50, max 200), django-filter backend.
- **Error shape (all non-2xx):** `{"error": {"code": "<machine_code>", "message": "<human>", "details": {…}}}`. Implemented via a global DRF exception handler in `apps/core`. Key codes: `validation_error`, `not_found`, `version_conflict` (409), `quota_exceeded` (429), `throttled` (429), `file_too_large` (413), `unsupported_file` (415), `document_encrypted` (423), `token_invalid` (401 public sign), `token_expired` (410 public sign — expired/completed/canceled requests), `account_required` (403 — guest hit an account-only feature; UI turns this into a signup prompt, never a dead end), `guest_expired` (410 — guest session/document past TTL, §21), `captcha_required` (403 — heavy op needs a challenge, §17).
- IDs are UUIDv4. All timestamps UTC ISO-8601. All list endpoints filterable/sortable via query params.
- OpenAPI: drf-spectacular; schema at `/api/schema/`, Swagger UI `/api/docs/` (dev-only). Every endpoint annotated; the schema is part of each phase's DoD.
- URL map (top level): `/api/auth/*` (JWT obtain/refresh) and **`/api/users/register/`** (the built route — note it is *not* `/api/auth/register/`; both accept an optional guest token to claim, §21.5), `/api/guest/session/` (mint/inspect guest session), `/api/guest/claim/` (transfer guest work to the authenticated account), `/api/uploads/image/` (ephemeral image asset → opaque `ref`, §13), `/api/users/*`, `/api/config/` (public: feature flags, **per-tier limits**, ads client id), `/api/folders/` (account-only), `/api/documents/…` (incl. `…/annotations/`, `…/text-words/` read models, phase 3), `/api/operations/` (cross-document ops), `/api/jobs/…`, `/api/signatures/`, `/api/sign-requests/…`, `/api/public/sign/{token}/…` (AllowAny + throttle), `/api/verify/` (signature verification), `/api/health/`.

## 7. Frontend conventions (Angular 22)

- 3-layer per skill: **core** services are pure/stateless HTTP; **facades** own `signal()` state and orchestration; **features** are dumb OnPush components injecting facades. No NgModules; `@if/@for` control flow; zoneless — never rely on zone-based hacks; DOM work outside Angular only inside the viewer wrapper.
- Skill's v19 snippets adapt to v22: `standalone: true` is implicit; OnPush is scaffolded by default; Signal Forms may be used for new forms (stable in v22) but Reactive Forms are acceptable — pick one per feature, don't mix within a component.
- Routes: `/` landing (public) · **`/{tool-slug}` public tool pages** (SSR/prerendered, indexable, each one a *working* tool — see §21.6) · `/auth/login|register` · `/app/doc/:id` (workspace — **open to guests**) · `/app/dashboard`, `/app/sign`, `/app/sign/new/:docId`, `/app/settings` (**account-only**, `accountGuard`) · `/s/:token` (public signing ceremony) · `/verify` (public) · `/legal/privacy|terms|esign-disclosure`.
- **Guards:** `accountGuard` protects only the account-only routes above. There is no app-wide auth guard — `/app/doc/:id` must render for a principal of either kind. An `accountGuard` rejection routes to `/auth/register?next=…&reason=…` with the reason surfaced as copy ("Create a free account to send signature requests"), never a bare login wall.
- **SSR:** `@angular/ssr` renders/prerenders the landing and tool pages for crawlability; `/app/**`, `/s/:token` and `/verify` stay client-rendered (no SEO value, and the ceremony must not be cached).
- Workspace shell = viewer (ngx-extended-pdf-viewer) + left thumbnail rail + right tool panel (routed tool tabs) + **overlay layer** component: a positioned div stack over each rendered page for placement interactions (annotations, fields, redaction boxes, whiteout, crop, signatures). Built once in phase 3, reused by 4/5/7/8.
- JWT in localStorage + interceptor per skill (tradeoff noted; CSP mitigations in phase 10). 401 → refresh flow → logout on failure.
- Jobs UX: a single `JobsFacade` polls active jobs (500 ms ×6, then 1 s; stop on terminal state), exposes per-job progress signals; global toast on success/failure; document reload on new version.

## 8. Coordinate system (critical, used by every placement feature)

Client sends geometry as **normalized page coordinates in visual space**: origin top-left of the page *as displayed* (rotation applied), `x,y,w,h ∈ [0,1]` relative to displayed page width/height, plus `page` (0-based). Server mapping is `fitz.Rect(x*W, y*H, (x+w)*W, (y+h)*H)` with `W,H = page.rect.width,.height`. The engine converts to PDF-native bottom-left space only where a library requires it (pyHanko visible-signature boxes). One utility: `pdf_engine/geometry.py` — the only place conversions live, with exhaustive tests for rotated pages (0/90/180/270).

⚠ **Corrected 2026-08-01 (phase 3).** This section previously claimed "PyMuPDF's page coordinate space is *also* top-left-origin with rotation applied", full stop. That is true of `page.rect` and `page.search_for`, and **false** of three things phase 3 depends on:

| API | Coordinate space |
|---|---|
| `page.rect` | **display** (rotation applied) |
| `page.search_for` | **unrotated** — measured; an unrotated page makes it indistinguishable from display, so this is easy to get wrong and invisible until a rotated page shows up |
| `page.get_text("words" \| "dict")` | **unrotated** |
| `page.insert_htmlbox` | **unrotated** — ⚠ *corrected 2026-08-23; this row said "**display** — the one writer that applies the rotation itself" and it was wrong* |
| `page.draw_rect`, `page.insert_image`, `page.insert_textbox`, `page.insert_text`, `page.show_pdf_page` | **unrotated** |
| `annot.rect`, `annot.vertices`, every `page.add_*_annot` | **unrotated** |
| `page.set_cropbox` | **unrotated** (phase 2's `crop_pages` already de-rotated) |
| `page.get_pixmap` | **display** — the only API that applies `/Rotate`, and therefore the only one that can prove what a reader sees |

⚠ **Corrected 2026-08-23.** The `insert_htmlbox` row above was false, and it was load-bearing: `content.py::_draw_band` cited it in a comment and handed `insert_htmlbox` a display rect, so **page numbers, headers/footers and Bates numbers landed in the middle of a rotated page, reading sideways** — measured on the real fixture at display (0.336, 0.698) for a bottom-centre stamp. Measured on PyMuPDF 1.28.0 / MuPDF 1.29.0: handed the *same* rect, `insert_htmlbox` writes to identical coordinates at `/Rotate 0` and `/Rotate 90`. It is no different from its siblings.

**The rule, restated without exceptions: no PyMuPDF writer applies the page rotation.** De-rotating the box is therefore only half of a correct placement — the content must also be *turned*, or it lands in the right place lying on its side. The turn is `geometry.content_rotation(page.rotation)`, which is the page's own rotation:

| Writer | How the turn is expressed |
|---|---|
| `insert_image`, `insert_textbox`, `insert_htmlbox`, `show_pdf_page` | `rotate=content_rotation(page.rotation)` |
| `insert_text` (no `rotate=` of its own) | `morph=(pivot, fitz.Matrix(content_rotation(page.rotation)))` |
| `add_freetext_annot` | `rotate=content_rotation(page.rotation)` |
| a Stamp annotation's appearance stream | `/Matrix` on the Form XObject (PDF 32000-1 §12.5.5) |

It is the rotation itself, **not its complement**. `(360 − N) % 360` — which five call sites used, in three different spellings — leaves a net turn of `2N − 360`: zero at 0° and 180°, a **half turn** at 90° and 270°. That is why it survived from phase 3 to 2026-08-23: every unrotated fixture agreed with it, and the two candidate formulas are indistinguishable at exactly the two rotations most tests use.

**Three lenses are blind to this class, which is why the tests must render.** A *round-trip* cancels the error (write and read use the same de-rotation — the trap this section already recorded in 2026-08-01). A *bounding box* is symmetric under a half turn, so `assert box.width > box.height` passed for months on upside-down output. *Text extraction* returns the same glyphs whichever way up they are, so `assert "P1" in text` passes on a sideways ribbon. Only `get_pixmap` plus deliberately **asymmetric** ink can tell upright from inverted, and every rotation test must include 0 and 180 as controls or it cannot distinguish "fixed" from "broken the other way".

So on a `/Rotate 90` page the two spaces differ by a quarter turn. The rule is therefore: **normalized geometry is always display space on the wire; the engine de-rotates on the way in (`page.derotation_matrix`) and re-rotates on the way out (`page.rotation_matrix`)** via `geometry.apply_matrix_rect` / `apply_matrix_point`. Omitting it is not a visible error in a round-trip — write and read cancel out, so create→extract agrees perfectly while the *file* disagrees with both. Only a rendered-pixel assertion catches it (`test_a_mark_on_a_rotated_page_renders_where_it_was_placed`).

**Replacing text is the exception to the rule.** `edit_text`/`add_text`/`find_replace` write in the page's *unrotated* space with the rotation temporarily zeroed, because the glyphs they replace were laid down there — the replacement then rotates with the page exactly as the original did. Using the display rect instead fails outright on a /Rotate 90 page: the display box of a normal line of text is tall and narrow, so horizontal layout cannot fit it. Stamps (headers, page numbers, Bates) do the opposite — they are *placed* from display space and *turned* with `content_rotation` — because a page number should read upright *to the viewer* regardless of how the page is rotated. *(Clarified 2026-08-23: "use display space" previously read as though the display rect were handed to the writer. It is not, and cannot be; it is de-rotated first, and the turn is what makes it read upright.)*

## 9. Data model (canonical — phases may add fields only by amending this doc)

**users.User**(AbstractUser): email unique (login), display_name, email_verified bool, accepted_tos_at datetime null, storage_bytes_used bigint (denormalized).
**core.GuestSession** (new — §21): id UUIDv4, token_hash (sha256 of a 256-bit urlsafe token; the raw token is never stored), created_at, last_seen_at, expires_at (sliding: last_seen + `GUEST_TTL_HOURS`, capped at created_at + `GUEST_TTL_MAX_HOURS`), ip_hash (salted — abuse correlation only, not analytics), user_agent, storage_bytes_used bigint, ops_count int, claimed_by FK→User null, claimed_at null. Indexed on token_hash (unique) and expires_at.
**core.UsageCounter**: **principal** — user FK null + guest_session FK null (exactly one non-null), period "YYYY-MM", sign_requests int, ocr_pages int, conversions int, heavy_ops int; unique(user, period) and unique(guest_session, period).
**core.EmailSuppression**: **email_hash unique** (HMAC-SHA256 of the lowercased address under `SECRET_KEY`), email (kept only when we already knew it — a staff entry or a bounce; blank for a one-click unsubscribe), reason ∈ {complaint, unsubscribe, bounce, manual}, created_at — honored by all outbound mail (phase 9). *Amended 2026-08-02, P9: keyed on the hash rather than the address, because the unsubscribe link has to carry the key and a URL carrying somebody's email ends up in browser history, proxy logs and `Referer` headers — the same reason `users/verification.py` signs a user id. Suppression is reversible (admin, and the page the link lands on): the link is printed in every footer and travels with a forwarded message, so it can be triggered by somebody who is not the addressee.*
**documents.Folder**: id, owner FK, parent FK null, name; unique(owner, parent, name). **Account-only** — guests have a flat session workspace, no folders.
**documents.Document**: id, **owner FK null**, **guest_session FK null** (exactly one of owner/guest_session non-null — enforced by a DB `CheckConstraint`, §21.2), **expires_at null** (set for guest documents; null once owned by a user), folder FK null, title, status ∈ {ready, processing, error}, page_count, size_bytes, is_encrypted bool, starred bool, metadata JSON (author/subject/keywords/dates, populated at ingest — amended 2026-07-19, P1), current_version FK→DocumentVersion null, error_message, last_opened_at, trashed_at null, created_at, updated_at.
**documents.DocumentVersion**: id, document FK (`versions`), seq int (unique per document, starts 1), storage_key, size_bytes, page_count, sha256, label (e.g. "Original", "OCR", "Signed"), created_by FK user null, job FK null, created_at. Immutable.
**jobs.Job**: id, **user FK null**, **guest_session FK null** (same one-of constraint), document FK null, type (operation type, §10), params JSON, base_version_seq int null, status ∈ {queued, running, succeeded, failed, canceled}, progress 0–100, error_code, error_message, **error_details JSON** (structured half of the §6 error shape — added phase 4), result JSON null, celery_task_id, created_at, started_at, finished_at.
**esign.SavedSignature**: id, user FK (**account-only**; guests draw an ephemeral signature held client-side for the session), kind ∈ {signature, initials}, method ∈ {draw, type, upload}, storage_key (PNG, alpha), typed_text, font, is_default, created_at.
**esign.SignRequest**: id, **owner FK null (`SET_NULL`)**, **document FK null (`SET_NULL`)**, **sender_email**, **sender_name** *(amended 2026-08-02, P10: a completed envelope is the counterparty's evidence of an agreement and must survive the sender closing their account (§10.1), so neither FK cascades and the sender is snapshotted as text at send — the certificate and the ceremony read the snapshot, not the FK)*, source_version FK *(`on_delete=PROTECT`, and a document with a sign request refuses permanent deletion — the signed record has to keep pointing at what was signed)*, title, message, status ∈ {draft, sent, completed, declined, expired, canceled, **canceled_by_abuse**}, envelope_code (human-short, stamped on pages, e.g. `ZEN-8F3KQ2`), expires_at, reminder_every_days int=3, sent_at, completed_at, final_key, certificate_key, final_sha256, created_at, updated_at.
**esign.Recipient**: id, sign_request FK (`recipients`), email, name, role ∈ {signer, approver, viewer, cc}, order int=1 (same order ⇒ parallel group; groups proceed in ascending order), status ∈ {pending, notified, viewed, consented, completed, declined}, token (urlsafe 43ch, unique), consent_at/ip/user_agent, decline_reason, last_notified_at, completed_at.
**esign.SignField**: id, sign_request FK, recipient FK, page int, x/y/w/h floats (§8), type ∈ {signature, initials, date_signed, text, checkbox}, required bool=true, label, value, **image_key** *(amended 2026-08-02, P8: a signature/initials field's value is a PNG, which belongs in object storage rather than in a text column)*, filled_at, created_at.
**esign.AuditEvent**: id, sign_request FK (`audit_events`), recipient FK null, type (created|sent|opened|consented|field_filled|signed|approved|declined|reminder_sent|expired|canceled|completed|seal_applied|downloaded), created_at, ip, user_agent, metadata JSON, prev_hash, event_hash = **hmac-sha256**(SECRET_KEY, prev_hash + canonical_json({type, created_at, recipient_id, ip, user_agent, metadata})) *(amended 2026-08-02, P8: keyed, not a bare digest — a plain chain is only self-consistent, and anyone able to write to the database could edit an event and recompute every hash after it while every check still reported "verifies")*. Append-only (no update/delete paths; enforced in model + DB permissions in prod).
**esign.AbuseReport** *(added 2026-08-02, P9)*: id, sign_request FK (`abuse_reports`), recipient FK, reason text, ip, user_agent, created_at; unique(sign_request, recipient) — a recipient's "I did not ask for this" from the ceremony footer. `ABUSE_REPORTS_TO_PAUSE` (3) **distinct** recipients pauses the request (`canceled_by_abuse`) and mails the owner. The pause event is written **without the reporter's request**, so the reporter's IP never reaches the owner-readable audit trail; the report row keeps it for staff.

## 10. Operation registry

All document mutations/derivations run as Jobs with `type` from this registry. Params are validated against per-type JSON Schemas living in `pdf_engine/schemas/` (shared with OpenAPI docs). Engine column = primary library.

| type | Phase | Engine | Params (summary) |
|---|---|---|---|
| rotate_pages | 2 | PyMuPDF | pages[], degrees ∈ {90,180,270} |
| delete_pages / duplicate_pages / reorder_pages | 2 | PyMuPDF | pages[] / pages[] / new_order[] |
| extract_pages | 2 | PyMuPDF | pages[], as_new_document bool, **separate bool** *(amended 2026-08-19, P2: one document per selected page — "pages 2, 9 and 40 as three files" rather than as one — titled `<source> — page N`, duplicates collapsed. It implies `as_new_document` and overrides it, because several files cannot be a new **version** of the one document they came from; the result is therefore `{documents: [...]}`, not `{document_id, version_id, seq}`.)* |
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
| watermark | 4 | PyMuPDF | text\|image, opacity, rotation, scale, tiling, range |
| bates | 4 | PyMuPDF | prefix, suffix, start, digits, position, range |
| overlay_pdf | 4 | PyMuPDF | overlay_document_id, mode ∈ {foreground, background}, range |
| set_metadata | 4 | PyMuPDF | title/author/subject/keywords (+clear flag) |
| set_bookmarks | 4 | PyMuPDF | toc[] (nested) |
| fill_form | 5 | PyMuPDF | values {field_name: value}, flatten_after bool |
| edit_form_fields_batch | 5 | PyMuPDF (+pyHanko for signature fields) | ops[]: add/update/delete of field specs {type, name, rect §8, page, options…} |
| import_form_data | 5 | PyMuPDF | format ∈ {json, csv}, data (the file's text, inline, ≤ 2 MB), flatten_after bool |
| ocr | 6 | OCRmyPDF | languages[], deskew bool, rotate_pages bool, clean bool, force bool |
| convert_from | 6 | Gotenberg / PyMuPDF | `upload_ref` **or `upload_refs[]`** (several images → one document, a page each) or `url`, `fit ∈ {a4, original}` → new document. Cross-document: no primary document in the URL |
| convert_to | 6 | pdf2docx / PyMuPDF / pymupdf4llm / OCRmyPDF | format ∈ {docx, images(png/jpg+dpi), txt, md, html, pdfa} → **export** (`produces="export"`: an artefact beside the document at `exports/{job_id}/…`, downloaded via `GET /api/jobs/{id}/download/`, never a new version) |
| repair | 6 | PyMuPDF (`repair_pdf`, phase-1) | — |
| compare | 6 | PyMuPDF | other_document_id, offset (v1 alignment), visual bool → **report**: `{pages[], summary}` returned inline on the job, not an export — it is consumed by the compare UI, which draws the rects itself, and minting a downloadable artefact for an inspection nobody downloads is storage nobody asked for. The "rendered" half is backlog. |
| encrypt | 7 | pikepdf | user_password?, owner_password, permissions{} (AES-256) |
| decrypt | 7 | pikepdf | password |
| set_permissions | 7 | pikepdf | owner_password, permissions{} |
| redact | 7 | PyMuPDF | areas[] (§8), patterns[] {preset\|regex}, search_text?, match_case, scope, fill, dry_run bool, fork_clean_copy bool, **only[]** (amended 2026-08-02, P7: the ids the dry run returned that the user left ticked — the phase's own "per-match include toggle" cannot be implemented without it. An **empty** list means "none of them", distinct from the key being absent) |
| sanitize | 7 | PyMuPDF+pikepdf | one boolean per item — metadata, xmp, javascript, embedded_files, hidden_layers_flatten, links_external, comments *(amended 2026-08-02, P7: a flat checklist rather than a nested `strip` set, because that is what the panel is and what phase-07 lists; `attachments` is spelled `embedded_files`, which is what the PDF calls them)* |
| self_sign | 8 | PyMuPDF | placements[]: {**signature_id \| signature_upload_ref**, page, rect §8}, include_date bool (always flattens). `signature_id` → `esign.SavedSignature` (account-only); **`signature_upload_ref` → an ephemeral uploaded/drawn PNG, which is how a guest signs** (§21.3) |
| finalize_sign_request | 8 (internal) | PyMuPDF+pyHanko+reportlab | sign_request_id (burn fields → seal → certificate) |
| generate_thumbnails (internal) | 1 | PyMuPDF | version, pages, width |
| revert_version | 1 | storage copy (no engine) | seq → new head version copied from v{seq} (§14) |

Version-producing ops → `result: {document_id, version_id, seq}` (split/merge/extract-as-new/convert_from → `{documents: [...]}`). Export ops → `result: {export_key, filename, content_type, size}` + `GET /api/jobs/{id}/download`. **Inspection ops** → `result: {report: {…}}` and **no version**: `find_replace` and `redact` with `dry_run: true` (amended 2026-08-02, P7), and `compare`. Minting a version for a search would put "Replaced 0 matches" in the history every time somebody looked (added phase 4).

Failures carry the §6 error shape's structured half in `Job.error_details` — `text_overflow`'s `fits_at_size` is the reason it exists, since the UI has to offer "shrink to N pt" and N is computed by the engine.

## 11. Job pipeline

`POST /api/documents/{id}/operations/ {type, params, base_version_seq, document_password?}` → validate schema + tier limits (§16) + **principal ownership** (§21.2) → create Job(queued) → dispatch to queue by type → **202** `{job}`. *(amended 2026-08-02, P7: `document_password` is the session password for an encrypted document — a **write-only sibling** of `params`, not a member of it, because it is a credential for the document rather than an input to the operation. Inside `params` it would have to be added to all forty op schemas, each of which would then have to remember to ignore it, and `Job.SENSITIVE_PARAMS` could not redact it generically. It is merged into the job's params for the worker, redacted from every API response, and dropped from the row when the job reaches a terminal state.)*  Cross-document ops use `POST /api/operations/`. Poll `GET /api/jobs/{id}/`. Cancel: `POST /api/jobs/{id}/cancel/` (revokes if still queued).

Worker algorithm (every mutation op): acquire Redis lock `zen:doc:{id}` (blocking, 120 s timeout) → refetch document → if `base_version_seq` ≠ `current_version.seq` → fail `version_conflict` → download blob → run engine fn (pure: bytes+params→bytes) → sha256, page count → upload `docs/{doc}/v{seq+1}.pdf` → create DocumentVersion → update Document (current_version, counts, sizes, status) → release lock → job succeeded. On any exception: job failed with sanitized error, document untouched (versions are immutable → no partial states, ever).

## 12. Queues & limits

| Queue | Ops | Concurrency | Soft/hard time limit |
|---|---|---|---|
| default | page ops (incl. split), annotate, forms, text/image edits, stamps, security (encrypt/decrypt/sanitize), self_sign, revert_version | 4 | 60 s / 120 s |
| heavy | ocr, convert_*, compress, compare, merge, alternate_mix, repair, **redact**, finalize_sign_request | 2 | 600 s / 900 s |
| render | generate_thumbnails, page renders | 4 | 30 s / 60 s |

*(amended 2026-08-02, P7: `redact` moved default→heavy. Redacting a long scan re-encodes every image the boxes touch and then re-extracts every page to verify, which does not fit a 60 s soft limit — and a legal disclosure bundle is the use case redaction exists for. The other three security ops are cheap and stay on `default`.)*

Workers: prefork, `max_memory_per_child=1.5 GB`, non-root, open PDFs per-task (never share fitz objects across tasks/threads). Celery `task_acks_late=True` + idempotent tasks (version creation is guarded by unique (document, seq)).

## 13. Storage

Bucket `zenpdf`, all private. Keys: `docs/{document_id}/v{seq}.pdf` · `thumbs/{document_id}/{seq}/p{page}@{w}.png` · **`uploads/{g|u}/{principal_id}/{ref}.{ext}`** (added phase 3 — ephemeral assets a principal uploaded: custom stamps, image watermarks and inserted images as `.png`; since phase 6 also *conversion sources* awaiting `convert_from`, which keep their own extension because LibreOffice decides what a file is from its name. Deleted as soon as the conversion has run; guest ones purged with the session either way) · `uploads/{u|g}/{principal}/{ref}.png` *(amended 2026-08-02, P8: signatures reuse the ephemeral image-asset namespace, so they inherit its quota metering, its principal-derived key and its guest purge rather than needing three new versions of each; ceremony field images live at `sign/{request}/fields/{field}.png` and rendered ceremony pages at `sign/{request}/pages/…`)* · `sign/{sign_request_id}/{final.pdf|certificate.pdf}` · `exports/{job_id}/{filename}` (TTL 24 h via beat GC).

**`uploads/…` refs are principal-derived, never client-supplied paths.** The API returns an opaque `ref` (`^[A-Za-z0-9_-]{6,64}$`) and every read rebuilds the key from the *caller's* principal, so a ref cannot address another principal's asset even if it leaks. Uploaded images are re-encoded to PNG on the way in, which normalizes the format for the engine and drops EXIF (GPS included) before it can be pasted into a document the user is about to share. Guest documents use the **same key layout** (keyed by document id, not principal) so claiming a session (§21.5) is a metadata-only reparent — no blob copying. Guest blobs are deleted by `guest_purge` (§15) when the session expires.

**Delivery default = API proxy with HTTP Range support** (`GET /api/documents/{id}/content/?version=` streams; Range honored so PDF.js can chunk; `Cache-Control: private` + ETag=sha256). Rationale: avoids depending on SeaweedFS presign/CORS behavior locally. Optimization flag `PRESIGNED_DELIVERY=true` → 302 to presigned GET generated against `S3_PUBLIC_ENDPOINT` (browser-reachable host — signatures bind the host header; documented gotcha). Thumbnails: `GET /api/documents/{id}/pages/{n}/thumbnail/?w=240&version=` — proxied, long Cache-Control, rendered on demand + cached to storage. Uploads: multipart to API (streamed to storage; size-capped). Direct-to-storage presigned PUT = backlog optimization.

## 14. Versioning & undo

Every mutation ⇒ new immutable version; `Document.current_version` advances. History panel lists versions (label, op, time, size). **Undo = revert**: `POST /api/documents/{id}/versions/{seq}/revert/` copies that version's blob as a new head version labeled "Reverted to v{seq}". *(Amended 2026-08-02: the retention cap is **removed**, not implemented. **three** tool pages say in so many words that the version history keeps every step and you can revert to any of them — `/organize-pdf`, `/annotate-pdf` and `/redact-pdf` (`tool-pages.ts:270,307,844`) — and six promise recoverability in some form. `/redact-pdf` makes it a *security* claim: "Version history keeps every earlier version — and those earlier versions still contain exactly what you have just removed." A per-**document** cap also does not bound the per-**principal** cost it was invented for: fifty versions each of unlimited documents is still unlimited. What bounds it is the storage quota — published, and read before the write on upload, image assets, conversion sources and claim, but **not** on either path that mints a version or a document (`_save_new_version`, `_create_document_from_bytes`), both of which bumped the counter and never looked at it. `core.limits.enforce_storage` is that check, on both. `_save_export` is left charging without refusing on purpose: an export is how somebody over quota gets their work out, and it deletes itself in 24 h.)*

## 15. Email & beat schedule

Django email → SMTP env (Mailpit in dev). HTML+text templates: sign invite, reminder, declined, completed (+links), email-verification. Beat: `sign_reminders` hourly *(amended 2026-08-02, P8: the cadence a user chooses is measured in days, so the task only has to notice that a day has passed — hourly does that with no clock-time assumption about anybody's timezone, and a stuck run is visible sooner)* (pending recipients, every `reminder_every_days`, stop at expiry) · `sign_expirations` hourly · `trash_purge` daily (trashed >30 d) · `exports_purge` **hourly** (>24 h) *(corrected 2026-08-02: §15 said daily; the schedule has run it hourly since phase 6 — the doc was wrong, not the code)* · **`guest_purge` hourly** (expired GuestSessions → hard-delete their documents, versions, thumbs and blobs; §21.4) · ~~`usage_recompute` daily 02:00~~ *(corrected 2026-08-02: **never implemented** — no such task and no beat entry exists. Named here and relied on at PROGRESS §"Redis throttle" as the thing that heals storage-counter drift; nothing does. Queued, not quietly written, because the counter it would reconcile is the one `enforce_storage` now refuses on)* · **`job_params_purge` daily** (blank the *inputs* of terminal jobs older than 30 d — patterns, replacement text, page lists; the row, and so the user's history, stays) · **`jobs_purge` daily** (delete terminal job rows older than `JOB_RETENTION_DAYS`, after their `exports/{job_id}/` prefix and with the bytes refunded). *(`version_retention_gc` removed 2026-08-02 — see §14.)*

## 16. Tiers, quotas & throttles (defaults; enforced from phase 2B, tightened in phase 9)

Limits are **tier-resolved, never hardcoded at call sites**. One function is the single source of truth:

```python
core.limits.for_principal(principal) -> Limits   # principal = User | GuestSession
```

`Limits` is a frozen dataclass built from `settings.TIERS[tier]`. Tier selection: `GuestSession → "guest"`; `User → user.plan` (default `"free"`).

| Limit | guest | free (account) | pro ⚠ *defined, not purchasable in v1* |
|---|---|---|---|
| Storage | 200 MB / session | 2 GB | 20 GB |
| Max upload | 25 MB | 100 MB | 500 MB |
| Max **image** upload (stamps/watermarks/signatures, §13 `uploads/…`) | 5 MB | 10 MB | 25 MB |
| Max pages / doc | 300 | 2000 | 5000 |
| Concurrent running jobs | 1 | 3 | 6 |
| **Metered ops** (see definition below) | 5 / hour | 40 / hour | 200 / hour |
| OCR pages | 50 / day | 2000 / month | 20 000 / month |
| Sign requests | — → `account_required` | 30 / month | 300 / month |
| Library, folders, saved signatures | — | ✅ | ✅ |
| File retention | 24 h sliding, 72 h hard cap (§21.4) | until trashed (+30 d trash) | same as free |
| Ads | shown | shown | hidden |

**`pro` ships as a config row only.** There is no billing code, no payment provider, no purchase path, and no upgrade UI in v1 — `User.plan` defaults to `free` and is settable only via Django admin. Its purpose is to force every quota check through a tier lookup *now*, so introducing billing later is "add a plan field writer + a webhook", not a refactor of every call site. See §21.7.

**⚠ "Metered ops" is a distinct set from the `heavy` queue (§12) — do not implement it off `op.queue`.**

```python
METERED_OPS = {"ocr", "convert_from", "convert_to", "compare"}   # genuinely expensive, low-volume
```

The `heavy` queue additionally contains `merge`, `alternate_mix`, `compress` and `repair`. Those are **flagship tool pages** (`/merge-pdf`, `/compress-pdf`) and are **never metered and never challenged** — rate-limiting or CAPTCHA-ing a guest's first merge defeats the entire strategy (§21.1). Queue membership is about worker sizing; `METERED_OPS` is about cost control. They are deliberately different sets.

**Counter storage:** monthly figures (`sign_requests`, `ocr_pages`, `conversions`, `heavy_ops`) live in `core.UsageCounter`. The **short windows above (per-hour, per-day) are Redis counters** via DRF scoped throttles, *not* model rows — `UsageCounter` has month granularity only (§9). Accepted consequence: flushing Redis resets in-flight guest rate windows (it is also the broker, so a flush is already disruptive); monthly quotas survive because they are in Postgres.

DRF throttles: guest 40/min, authed 120/min, auth endpoints 10/min, public-sign endpoints 20/min/IP, verify 10/min/IP. **Guest throttles are keyed on `(guest_token, ip_hash)` and the stricter of the two wins** — keying on the token alone would make clearing localStorage a free quota reset (§21.4). All quota rejections use `quota_exceeded`; tier-gated features use `account_required`. `GET /api/users/me/usage/` reports consumption for either principal; `GET /api/config/` exposes the *current principal's* limits to the UI so the client can pre-empt rejections rather than discovering them at 429.

## 17. Security model (summary — phase 10 hardens)

Upload validation: size cap → magic bytes `%PDF` → `pikepdf.open` parse (repair prompt on failure) → page cap (*the "⚠ not actually implemented" aside here is retired 2026-08-22: Phase 2B added the check, exactly as the aside said it would. `MAX_PAGES` / `GUEST_MAX_PAGES` are enforced in `documents/services.py::ingest_pdf` — the first point where the page count is known — and covered by `test_limits.py::test_max_pages_is_enforced_at_ingest_for_guests`, `..._for_accounts` and `test_max_pages_boundary_accepts_exactly_the_limit`*) → encrypted? mark `is_encrypted`, require password to operate (423). Workers: time/memory limits (§12), non-root, untrusted parsing confined to engine libs kept current. SSRF (url→pdf): scheme allowlist http/https + deny private/link-local IPs (resolve-then-check) before handing to Gotenberg. XSS: no `innerHTML` with document-derived text, Angular default escaping. Public sign tokens: 256-bit, single-purpose, expire with request, throttled. JWT per skill (rotate+blacklist). Audit chain append-only. Admin site disabled in prod (or IP-gated). CSP + security headers in prod nginx (phase 10). PDF JS-execution: PDF.js scripting stays disabled (default).

**Anonymous-access hardening (§21).** Removing the login wall removes the cheapest abuse filter, so it is replaced deliberately, not dropped: (a) guest tokens are 256-bit, stored **hashed**, single-purpose, and carry no user data; (b) guest throttles key on token *and* salted IP hash, stricter wins; (c) heavy ops (ocr, convert_*, compare) from a guest require a **Cloudflare Turnstile** challenge once per session before the first heavy op, behind `CAPTCHA_ENABLED` (adapter pattern, off in dev) — cheap ops are never challenged, because friction on `merge` defeats the entire strategy; (d) tier caps (§16) bound worst-case compute per session; (e) **no anonymous party can ever choose a recipient address** — creating and sending sign requests is account-only (§21.3), so every outbound address originates from an authenticated owner. (Stated precisely, because Phase 8 legitimately *does* send system mail on actions taken by unauthenticated parties — a signer completing or declining at `/s/:token` notifies the owner and the next group, and phase-09's report-abuse endpoint mails the owner. Those are fixed, pre-existing addresses, not attacker-chosen ones. The invariant that matters for spam relay is address *selection*, not message *triggering*.) (f) guest blobs are hard-deleted on expiry (§21.4), bounding both storage cost and breach blast radius. `ip_hash` uses a rotating salt and exists only for abuse correlation — it is not analytics and must not be surfaced in any user-facing or ad-facing payload. **Rotation needs no salt-version column precisely because sessions live at most `GUEST_TTL_MAX_HOURS` (72 h): rotate no more often than that and every stored hash has already aged out.** Rotating faster silently voids the IP leg of the throttle key for in-flight sessions — if that is ever wanted, add a version column first.

## 18. Testing strategy

Backend: pytest + pytest-django, `CELERY_TASK_ALWAYS_EAGER=True` for API tests; engine functions get **golden tests** against a fixture corpus (`tests/fixtures/pdfs/`: text.pdf, scanned.pdf (image-only), form.pdf (AcroForm), encrypted.pdf, rotated-90.pdf, unicode.pdf, corrupt.pdf, large-generated.pdf 500 pp) asserting page counts, extracted text, form values, encryption state — not byte-equality (PDF output nondeterminism). Coverage gate: apps 85%, pdf_engine 90%. Frontend: unit tests for every facade + core service (HttpTestingController); `ng test` with the v22 default runner ⚠. E2E: Playwright against the full compose stack (`infra/test.sh --e2e`), one happy-path spec per phase (see phase docs). CI note: any CI must run `ruff`, `mypy` (loose), `eslint`, backend tests, frontend tests.

**Three rules the gate learned the hard way** *(added 2026-08-22, `fix/e2e-gate-hardening`; each one is a defect that hid because a check stopped short of what it claimed to prove)*:

1. **A page is not drawn until its pixels say so.** No test may conclude that a document rendered from a 200, from the presence of a viewer element, or from a `pdfLoaded`-class event. The workspace exposes `data-test=viewer-drew` (pdf.js `pageRendered`) and `data-test=overlay-drew` (the page raster decoded with a non-zero natural size), both keyed to the URL that drew so a save or a revert withdraws the claim; `e2e/tests/drew.ts` waits for the marker and then reads the canvas back, asserting more than three distinct colours across **every pixel** (counting stops at 64, so only a blank surface pays for a full scan). Production rendered nothing at `/app/doc/:id` for ten days while every existing check stayed green. *(Corrected 2026-08-22, PR #24: this said "rows sampled at a 97 px stride", and a stride is how a sampler steps over four lines of text at the top of a page and calls a drawn page blank — measured on production the first time it was driven by hand.)*
2. **A suite tests the code the workers booted with.** Celery does not hot-reload, so `infra/test.sh --e2e` restarts `worker-default`, `worker-heavy`, `worker-render` and `beat` and waits for `/api/health/` to report `status: ok` before driving a browser; `infra/up.sh` warns when a worker container predates the newest source file under `backend/`. A stale worker produced two wrong diagnoses of one spec in a single day, and a false *pass* would not have been noticed at all.
3. **A gate must be able to say what it did not run.** pytest runs with `-rs` and the gate asserts the skip *set* (four Postgres-only query-plan tests, exercised by `--pg`) rather than its size; Gotenberg is health-checked before pytest so a drifted container fails loudly instead of turning ten conversion tests into skips behind an exit code of 0. `@quarantine` now excludes (`grepInvert`, `INCLUDE_QUARANTINE=1` to override) and is a debt marker requiring a Human-review-queue row — retries stay at zero.

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
# Limits (see §16 — per-tier values live in settings.TIERS; these are the "free" overrides)
MAX_UPLOAD_MB=100  USER_STORAGE_QUOTA_MB=2048  MAX_PAGES=2000
SIGN_REQUESTS_PER_MONTH=30  OCR_PAGES_PER_MONTH=2000
# Anonymous access (see §21)
GUEST_ACCESS_ENABLED=true   GUEST_TTL_HOURS=24        GUEST_TTL_MAX_HOURS=72
GUEST_STORAGE_QUOTA_MB=200  GUEST_MAX_UPLOAD_MB=25    GUEST_MAX_PAGES=300
CAPTCHA_ENABLED=false       TURNSTILE_SITE_KEY=       TURNSTILE_SECRET_KEY=
# Ads (phase 9) — false is the shipped default; with it, no third-party code loads
ADS_ENABLED=false           ADS_PROVIDER=adsense      ADSENSE_CLIENT_ID=
ADS_SLOT_DASHBOARD_RAIL=    ADS_SLOT_DASHBOARD_INLINE=
ADS_SLOT_TOOL_RESULT=       ADS_SLOT_LANDING=
CONSENT_REQUIRED_REGIONS=AT,BE,…,GB,CH   # browser reports its IANA timezone
# Abuse controls (phase 9, §9B)
ABUSE_CONTACT_EMAIL=abuse@zenpdf.local   ABUSE_REPORTS_TO_PAUSE=3
MAX_RECIPIENTS_PER_REQUEST=10            MAX_DISTINCT_RECIPIENTS_PER_DAY=50
EMAIL_VERIFICATION_TTL_HOURS=48          TRASH_RETENTION_DAYS=30  JOB_PARAMS_RETENTION_DAYS=30  JOB_RETENTION_DAYS=365
THROTTLE_UPLOAD=20/hour                  THROTTLE_VERIFY=10/min
THROTTLE_VERIFY_HOUR=60/hour             THROTTLE_PUBLIC_SIGN=20/min
THROTTLE_PUBLIC_SIGN_TOKEN=200/day
# Observability (phase 10) — all inert unless set
SENTRY_DSN=                 SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=             SENTRY_TRACES_SAMPLE_RATE=0.0
LOG_FORMAT=json             # `text` for a readable dev console
# Admin (§17) — an empty allowlist DENIES, which is the safe default
ADMIN_ENABLED=false         ADMIN_URL_PATH=admin/     ADMIN_IP_ALLOWLIST=
# Transport (prod only)
SECURE_SSL_REDIRECT=true    SECURE_HSTS_SECONDS=63072000
SECURE_HSTS_PRELOAD=false   # a one-way door for the whole domain
GUEST_IP_HASH_SALT=dev-rotate-me
# Ads (phase 9)
ADS_ENABLED=false  ADSENSE_CLIENT_ID=
# Seed
SEED_ADMIN_EMAIL=admin@zenpdf.local  SEED_ADMIN_PASSWORD=admin12345
```

**Added 2026-08-22 — variables the code reads that this matrix never listed.** Each is in `config/settings/base.py` or in production's start command; the omission is why one of them (`NUM_PROXIES`) ended up with three different values in three files and its real value only in a dashboard.

```
# Proxy topology — how many hops append to X-Forwarded-For before us.
# Get this wrong and per-IP throttling silently collapses onto the edge's address.
NUM_PROXIES=1     # default (base.py:190) — correct behind NO proxy
#           =2    # compose: TLS terminator → nginx → gunicorn (infra/.env.prod.example)
#           =3    # Railway production — MEASURED, not guessed (docs/ops/railway.md gotcha 4).
#                 # *Amended 2026-08-23:* set in the image (`ENV NUM_PROXIES=3` in
#                 # infra/railway/api.Dockerfile), not only in the Railway dashboard —
#                 # a project rebuilt from this repo used to get the default of 1 and
#                 # collapse every per-IP throttle onto the edge's address. A service
#                 # variable still overrides the image. Held by
#                 # apps/core/tests/test_client_ip_topology.py, which parses the
#                 # Dockerfile (the api container mounts infra/railway/ read-only so
#                 # the hermetic suite can actually open it).
# Cache — separate Redis db from the broker (base.py:337). Throttle counters,
# password-failure buckets and the guest-session cache all live here.
CACHE_URL=redis://redis:6379/1        # default: REDIS_URL with db 1
# Absolute base for URLs the API builds itself (base.py:25); defaults to
# FRONTEND_BASE_URL. Set it where the API is reachable at its own hostname.
API_BASE_URL=
# Railway only — the signing .p12 as base64, decoded into SIGNING_CERT_PATH by
# each service's start command (`… | base64 -d > /tmp/certs/zenpdf.p12`), because
# Railway has no file mounts. Not read by Django directly; see docs/ops/secrets.md
# and infra/certs/prod/RAILWAY-SECRETS.md.
SIGNING_CERT_B64=
```

Other production-only values live in the Railway dashboard and are documented in `docs/ops/railway.md` rather than here: `ALLOWED_HOSTS` (which **must** include `healthcheck.railway.app` or the platform's probe fails), `CSRF_TRUSTED_ORIGINS`, and the per-service start commands.

## 20. Definition of Done (every phase)

1. All acceptance criteria demonstrated on a fresh `./infra/up.sh` stack. 2. Migrations idempotent from zero. 3. Unit/integration tests green; coverage gates hold; new engine fns have golden tests. 4. Playwright happy-path for the phase green. 5. OpenAPI schema updated & accurate. 6. Lint clean (ruff, eslint). 7. No `TODO`/dead code introduced; feature flags documented. 8. `development-plans/PROGRESS.md` updated per its Update protocol (status, evidence, decisions). 9. **From Phase 2B onward:** every user-facing tool the phase ships is reachable and fully usable by a guest (or is listed in §21.3 as account-only *with a written reason*), and ships its public SSR tool page (§21.6) with title/meta/H1/FAQ copy. A tool that works only when logged in is an incomplete phase.

## 21. Access model (anonymous-first) — normative

Added 2026-07-31 (owner decision). **Supersedes the original "accounts + JWT, login required" model** recorded in README's locked-decisions table and in §1 as first written. Where any phase doc still assumes an authenticated-only request, this section wins.

### 21.1 Principle

The product is monetized by advertising. Ad revenue is a function of sessions, so **every gate is a direct multiplier on revenue** — and the highest-traffic operations (merge, split, compress, rotate, convert) are exactly the ones that are stateless and need no identity at all. The rule is therefore:

> **If an operation is file-in → file-out, it must work without an account. No exceptions, no "sign up to download", no watermark-unless-registered.**

Accounts are an upgrade purchased with value already delivered, not an entry toll. A guest who has done three operations and has files in a session workspace is a far better signup prospect than a cold visitor staring at a login form — see §21.5.

### 21.2 Principals & ownership

Every request resolves to exactly one **principal**:

| Principal | Credential | Resolved by |
|---|---|---|
| `User` | JWT `Authorization: Bearer …` (localStorage, per skill) | `PrincipalAuthentication` |
| `GuestSession` | `X-Guest-Token: <raw token>` (localStorage) | `PrincipalAuthentication` |

**Why a header, not a cookie:** it matches the existing JWT-in-localStorage interceptor pattern, keeps the API stateless and CSRF-free, and avoids a cookie-consent conversation on a page whose entire job is to convert a first-time visitor in five seconds. Tradeoff accepted: a guest who clears site data loses access to in-flight documents (they are ephemeral by design anyway, §21.4).

Minting is **lazy**: a guest token is created on the first *write* (upload or operation), never on a page view — so a bounced visitor costs zero rows. The response to that first write carries `X-Guest-Token`; the client persists it and sends it thereafter. `POST /api/guest/session/` exists for explicit mint/inspect.

Ownership generalizes from `owner == request.user` to a **single choke point**:

```python
# apps/core/principals.py — the ONLY place ownership is expressed.
def owned_by(qs, principal):        # -> filtered queryset
def assert_owned(obj, principal):   # -> raises NotFound (404, never 403 — no existence leak)
def principal_of(job):              # -> Job.user or Job.guest_session; NEVER read job.user directly
def owner_kwargs(principal):        # -> {"owner": u} | {"guest_session": g}, for object creation
```

**The worker layer is part of this, and is the easy thing to miss.** Celery tasks currently resolve ownership through `job.user` (e.g. `Document.objects.get(id=…, owner=job.user)` and `_create_document_from_bytes(owner=job.user, …)` in `documents/tasks.py`). For a guest job `job.user` is `None`, which fails two ways: creating a document with `owner=None` and `guest_session=None` violates the exactly-one-of constraint, and `filter(owner=None)` compiles to `owner_id IS NULL` — i.e. a lookup that matches *any guest's* document. Both must go through `principal_of(job)` / `owner_kwargs(...)`.

`Document`, `DocumentVersion` (via document), `Job`, and `UsageCounter` each carry nullable `owner`/`user` **and** nullable `guest_session`, with a DB `CheckConstraint` that exactly one is set. `Folder`, `SavedSignature`, `SignRequest`, `Recipient`, `SignField` and `AuditEvent` remain user-only.

**Isolation is a test obligation, not a convention.** The existing router-wide cross-user isolation fixture (`test_isolation.py`, P1) gains a guest twin proving: guest A → 404 on guest B's documents; guest → 404 on any user's documents; user → 404 on any guest's documents; and an expired guest token → 410 `guest_expired`, not a silent 404.

### 21.3 What requires an account — the complete list

Account-gated features need a written reason. This is the whole list; anything not here is guest-accessible.

| Feature | Why an account is genuinely required |
|---|---|
| Persistent library, folders, starring, trash | Inherently stateful — there is no library without a durable identity. |
| Version history beyond session TTL | Same. Guests get full history *within* the session. |
| Saved signatures & initials | Reusable credential-like assets; storing them against an ephemeral token is worse for the user, not better. |
| **Sending** signature requests | ESIGN/UETA attribution requires an identified sender; and only an authenticated owner may **choose a recipient address** — otherwise the send path is a spam relay pointed at our own domain reputation (see §17e for the precise invariant: address *selection*, not message *triggering*). **Non-negotiable.** |
| Higher tier limits (§16) | The upgrade itself. |
| Usage **history across sessions** | Needs durable counters. Guests still see *current-session* usage via `/api/users/me/usage/` (storage, ops used, time remaining) — they just have no cross-session history. |

Explicitly **guest-accessible**, including the ones that feel like they should not be: all 14 page operations · viewer, search, outline · annotations · content editing (text, images, links, watermark, headers/footers, Bates) · form fill, field creation, flatten · OCR and every conversion (rate-limited + Turnstile per §17) · encrypt/decrypt/permissions · redaction and sanitize · **self-sign** (draw/type a signature, place it, flatten — ephemeral, not saved) · `/verify` · **receiving** and completing a signature request via `/s/:token` (already tokenized and account-free).

`/verify` and the signing ceremony stay account-free *and* ad-free — they are trust surfaces (see phase-09 §9A for the ad-placement rules).

### 21.4 Guest lifecycle & retention

`expires_at` slides to `last_seen_at + GUEST_TTL_HOURS` (24) on every authenticated-as-guest request, hard-capped at `created_at + GUEST_TTL_MAX_HOURS` (72). Beat job `guest_purge` runs hourly and **hard-deletes** expired sessions: documents, versions, thumbnails, exports, and their storage blobs. No soft-delete, no trash — for guests, expiry means gone.

This is a **feature to advertise, not a limitation to hide**: "No account. Files auto-deleted within 24 hours." It is also load-bearing for cost (bounded anonymous storage) and for privacy posture (bounded breach blast radius).

The UI must make expiry legible: a persistent, non-alarming banner in the guest workspace showing time remaining, with the CTA from §21.5. Guests must never lose work silently.

### 21.5 Claim-on-signup — the conversion path

The single most valuable moment in the funnel. `POST /api/users/register/` and `POST /api/auth/login` (the routes as actually built — **not** `/api/auth/register/`) accept the `X-Guest-Token`; `POST /api/guest/claim/` does it explicitly for an already-authenticated user.

Claim is a **metadata-only reparent** (blob keys are principal-independent, §13). In one transaction, idempotent, it moves **every principal-bearing row — not just documents**:

1. `Document`: set `owner`, clear `guest_session` and `expires_at`.
2. **`Job`**: set `user`, clear `guest_session`. Non-optional — an in-flight job left guest-owned disappears from `owned_by(qs, user)` the instant the user registers, so the file they just signed up to keep stops polling. This is the exact moment the funnel is selling.
3. **`UsageCounter`**: fold guest counters into the user's row for the same period with `get_or_create` + `F()` increments (the `unique(user, period)` constraint means merge, never insert). Rule: **sum** — work already done is work already charged; discarding it would let a user reset a monthly quota by laundering it through a guest session.
4. `GuestSession`: set `claimed_by`/`claimed_at`, fold `storage_bytes_used` into `User.storage_bytes_used`, and expire the session so `guest_purge` cannot later cascade-delete rows the user now owns.

Pre-flight: if the incoming documents would exceed the user's storage quota, respond `quota_exceeded` **listing what would be transferred and by how much it overflows** — never partially claim, and never silently drop files.

**After a successful claim the client MUST discard its guest token** and use the JWT alone; a claimed token is dead server-side and replays return 410 `guest_expired`. Without this the browser keeps writing into a claimed session that `guest_purge` deletes within 72 h — losing a logged-in user's files, the worst failure this design can produce.

**401 handling (amends §7).** The existing interceptor's `401 → refresh → /auth/login` path must fire **only for a JWT principal**. A guest 401 means "your session ended": clear the token, mint a new one on the next write, and surface an inline "your files expired" notice — never a redirect to a login form, which would reinstate the wall this whole section removes.

Product rule: the prompt to sign up is triggered by *value*, not by *time or count* — shown when the guest has at least one successful output worth keeping, or when they hit an `account_required` feature. Never an interstitial, never before the first result renders.

### 21.6 Public tool pages & SEO

An ad-funded product with one landing page has no business model. Organic search *is* the acquisition channel, and the competitors rank on per-tool pages. Therefore each tool ships a **public, server-rendered, individually indexable page that is itself the working tool** — dropzone above the fold, no login prompt anywhere in the path, result downloadable in place with an "open in workspace" continuation.

Route ↔ phase map (each lands with its phase, per the §20 DoD addition):

| Phase | Slugs |
|---|---|
| **2B** | `/merge-pdf` `/split-pdf` `/compress-pdf` `/rotate-pdf` `/delete-pdf-pages` `/extract-pdf-pages` `/organize-pdf` — the Phase-2 operations, but their pages ship in 2B because Phase 2 is already ✅ |
| 3 | `/annotate-pdf` |
| 4 | `/edit-pdf` `/watermark-pdf` `/add-page-numbers` |
| 5 | `/fill-pdf-form` |
| 6 | `/ocr-pdf` `/pdf-to-word` `/word-to-pdf` `/jpg-to-pdf` `/pdf-to-jpg` `/html-to-pdf` `/compare-pdf` `/repair-pdf` |
| 7 | `/protect-pdf` `/unlock-pdf` `/redact-pdf` |
| 8 | `/sign-pdf` (+ `/verify`, already public) |

Each page owns: unique `<title>`/meta description/H1, ~300 words of honest task copy, an FAQ block emitting `FAQPage` JSON-LD, `SoftwareApplication` JSON-LD, canonical URL, and OpenGraph tags. `sitemap.xml` is **generated from the route table**, not hand-maintained — a tool page that exists but is not in the sitemap is a bug. `robots.txt` allows all tool pages and disallows `/app/`, `/s/`, `/api/`.

Ads render on tool pages (notably the post-result surface — the natural pause, and the highest-value slot); never on the viewer canvas, ceremony, or verify pages.

### 21.7 Paid tier — designed for, deferred

Owner decision 2026-07-31: **v1 ships free and ad-supported with no billing.** No payment provider, no checkout, no upgrade UI, no `pro` purchase path. The `pro` row in §16 exists solely so that every limit check already flows through `for_principal()`.

When billing is revisited, the honest read from that decision is recorded here so it is not relitigated from scratch: **do not sell ad-removal alone.** People who dislike ads install an ad blocker for free, and ad-removal-only subscriptions convert poorly. A paid tier should sell *utility* — larger files, priority queue, batch processing, longer retention, unlimited sign requests, API access — with ad-removal as an included perk. That is why the `pro` column above is defined in terms of limits rather than "no ads".
