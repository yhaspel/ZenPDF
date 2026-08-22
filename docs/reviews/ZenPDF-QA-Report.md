> **Historical — findings implemented 2026-08-04** (PROGRESS §"Session log — QA findings"); **only M6 remains open** (Human review queue: DNS rebinding defeats the URL→PDF guard — a bounded, deliberate acceptance, not an oversight). The remediation prompt that executed this report is `IMPLEMENT-FINDINGS-PROMPT.md`, beside this file. Kept as the record of what was found and how it was answered.

# ZenPDF — Full QA & Review Report

**Prepared by:** Testing/Review engineering pass (design critique + code review + bughunt + full UI test)
**Date:** 2026-08-03
**Build reviewed:** `main` — Phases 0–10 engineering complete (Phase 10 "awaiting human review" per `PROGRESS.md`).
**Stack:** Django 6.0.7 / DRF + Celery/Redis + Postgres + S3 (SeaweedFS) backend; Angular 22 (standalone, signals, SSR prerender) frontend.

---

## 1. Executive summary

ZenPDF is a genuinely well-engineered product. The access-control core is a single ownership choke-point (`apps/core/principals.py`) applied on every id-bearing route — including the worker layer — and it is backed by a resolver-walking isolation sweep. **No IDOR and no authentication bypass were found.** Redaction really removes content (glyph + image-pixel excision with a re-extraction verification pass), the e-sign audit trail is HMAC-keyed and append-only, SSRF is defended in depth, secret defaults fail closed, and the frontend has no XSS sinks (no `innerHTML`/`bypassSecurityTrust*`/`DomSanitizer` anywhere). Functionally the app is solid: an independent end-to-end run passed **46 of 47** specs, with the single failure being a headless-browser download-event artifact rather than a product defect.

That said, the review surfaced **3 High**, **7 Medium**, and **15 Low** engineering findings, plus **7 design/UX** observations. The three most important:

1. **Per-IP rate limits are unreliable as shipped (High).** `NUM_PROXIES=1` does not match the documented production topology (TLS-terminator → nginx → gunicorn = two hops), so every client collapses into a single throttle bucket — turning the anti-brute-force `auth` limit and the abuse ceilings into a global lockout DoS. In the dev configuration the header is fully client-controlled and the bypass reproduces live.
2. **The per-tier page cap is not enforced on the version-write path (High).** A guest can drive a document to hundreds of thousands of pages with ordinary `duplicate_pages`/`insert_blank` calls, defeating a control §17 calls load-bearing.
3. **Image decompression-bomb DoS in signature handling (High).** The signature image is fully decoded before its size is checked, and the public ceremony path has no byte cap at all — one invited signer can OOM-kill the API process repeatedly.

None of the three requires an account relationship an attacker can't obtain (guest, or an ordinary signing invitation), and all three have small, well-scoped fixes. A one-shot remediation prompt for Claude CLI accompanies this report.

### Severity tally

| Severity | Engineering | Design/UX |
|---|---|---|
| 🔴 High | 3 | — |
| 🟠 Medium | 7 | — |
| 🟡 Low | 15 | — |
| 🎨 Design | — | 7 |

---

## 2. Methodology, coverage & environment

The app was stood up natively in a Linux sandbox (no Docker daemon available): Postgres 16, Redis 7, SeaweedFS (S3), Mailpit, the Django API + a Celery worker across all three lanes (`default`/`heavy`/`render`) + beat, and the Angular dev server. Migrations, `init_storage`, and `seed_dev` all succeeded; `/api/health/` reported `db/redis/storage: true`.

Four independent review passes were run in parallel over the source, then the top findings were re-verified by hand against the code and, where possible, the running app:

- **Backend security & access-control review** — `apps/core`, `apps/users`, `config`, and the authz paths into the other apps.
- **Backend engine/jobs/documents/esign review** — the PDF engine, the async job pipeline, storage, and the e-sign subsystem.
- **Frontend review** — the Angular core/abstraction/features layers, guards, interceptors, state.
- **Adversarial cross-stack bughunt** — SSRF regex correctness, throttle math, retention/TTL cross-checks, token flows, migrations, consent/ads, dead code, contract drift (with live `curl` against the API).

**Full UI test pass.** The app's own Playwright suite was run against the live stack (Playwright pinned to 1.55 to match the sandbox's Chromium 1194): **46 passed / 1 failed** across phases 0–5, 7–10 (see §3). In addition, an exploratory pass drove every major surface as both guest and registered user and captured **29 screenshots** (landing, all 24 tool pages' template, auth, dashboard empty/populated, the workspace viewer and all six editing panels, settings, the full sign-request builder, and a live end-to-end signing ceremony) — with **zero uncaught console/page errors** on every flow except self-inflicted `429`s from load.

**Coverage limitation — Gotenberg.** Office-format conversions (`docx→pdf`, `url→pdf`, etc.) route through a Gotenberg HTTP service that requires Docker and was therefore not running. Those specific conversion paths (most of Phase 6's *outbound* office rendering; OCR and PDF-native paths were exercised) were reviewed statically but not executed end-to-end. This is an environment limitation, not a product gap, and is called out where relevant (BUG-2/BUG-3 SSRF live-demo, e2e phase-6).

---

## 3. Functional UI test results

Independent Playwright run against the live stack, `phase-*.spec.ts` (Gotenberg-dependent phase-6 excluded):

| Suite | Result | Notes |
|---|---|---|
| phase-0 (auth: register/login/session guard) | ✅ pass | |
| phase-1 (upload, view, search, rename, trash, restore) | ✅ pass | |
| phase-2 (page organization) | ✅ pass | |
| phase-2b (guest merge → register → claim) | ⚠️ 1 fail | Merge **succeeds** (result renders, backend `download/` returns `200`); the `waitForEvent('download')` assertion times out under headless Chromium's blob-anchor handling. **Harness artifact, not a product defect** — verified the endpoint returns the file and `saveBlob()` is a correct blob-anchor download. |
| phase-3 (annotations) | ✅ pass | |
| phase-4 (content editing) | ✅ pass | |
| phase-5 (forms) | ✅ pass | |
| phase-7 (security & redaction) | ✅ pass | |
| phase-8 (e-signatures, multi-party, ceremony, verify) | ✅ pass | |
| phase-9 (ads & abuse controls) | ✅ pass | |
| phase-10 (debt/observability) | ✅ pass | |
| **Total** | **46 / 47** | Only the harness artifact above. |

Exploratory findings feed the design critique (§4). No functional blockers surfaced beyond the code findings in §5–§6.

---

## 4. Design critique (`/design:design-critique`)

Based on the 29 captured screenshots. The visual language is clean, modern, and coherent (Tailwind, generous spacing, a restrained indigo/slate palette), the empty/loading states are mostly thoughtful, and the e-sign ceremony in particular is careful and legally literate (version-stamped ESIGN disclosure, honest "not a qualified electronic signature" footer, an unskippable consent gate). The critique below is about consistency and a few usability gaps, not a redesign.

**D1 — Primary-button color is inconsistent across the product.** The enabled primary CTA is deep indigo in some places ("Save" in Settings, "Sign here" and "Download" on the result panel, the landing "Create free account") but a light lavender in others, and the ceremony's final CTA ("Finish signing") is **green**. Worse, that same light lavender is used for *disabled* states elsewhere ("Merge PDFs" before files are added, "Agree and continue" before the box is ticked), so an enabled lavender button and a disabled lavender button look nearly identical. Establish exactly one primary color and one disabled treatment, and apply them everywhere. *(Screens: 04-register, 02-tool-merge, 22-settings, 29-ceremony-sign.)*

**D2 — The dashboard shows just-uploaded files twice.** After an upload, each file appears in a checkmarked confirmation list *and* simultaneously as a card in the library grid below it (e.g. `text.pdf ✓`, `form.pdf ✓`, `hebrew-rtl.pdf ✓` above three matching cards). The relationship isn't explained and reads as duplication/clutter. Either fold the upload confirmation into the cards (a transient badge on the new card) or dismiss the list once the cards render. *(Screen: 14-dashboard-populated.)*

**D3 — The workspace stacks two toolbars with overlapping affordances.** In the base viewer, the app's own tool nav (Organize / Edit / Annotate / Forms / Convert / Compare / Sign / Protect / Split / Compress / Download) sits directly above the full **pdf.js native toolbar**, which independently exposes rotate, print, download, "add text", "add image", and a freehand pen. That's two ways to rotate, two ways to download, and — critically — a second annotation surface whose marks are *not* part of ZenPDF's own annotation model. Consider hiding/trimming the pdf.js toolbar's editing controls so the app owns editing unambiguously. *(Screens: 15-workspace-viewer vs 17-panel-annotate, which is the good, custom overlay.)*

**D4 — The landing page is 24 undifferentiated text cards.** Every tool is a same-weight card with a title and a near-duplicate sub-label ("Merge PDF files" / "Merge PDFs"; "Rotate PDF pages" / "Rotate PDF"). There are no icons, no grouping (Organize / Convert / Secure / Sign), and no search/filter, so scanning to the tool you want is slow and the sub-labels add little. Group the cards into labeled sections and/or add icons and a filter. *(Screen: 01-landing.)*

**D5 — Disabled primary buttons are hard to read.** The disabled "Merge PDFs" / "Create account" state is white text on light lavender — low contrast, and the label is barely legible. Darken the disabled text or use a slate-on-gray disabled style. *(Screens: 02-tool-merge, 04-register.)*

**D6 — The auth pages are bare.** `/auth/register` and `/auth/login` render a floating card with **no ZenPDF header/logo and no link back to the marketing site** — a user who lands there directly can only escape via browser back. There's also no password-visibility toggle and no inline hint about the 8-char/common-password rule, so the first feedback is a post-submit rejection. Add the header/logo (as a home link) and a lightweight password affordance. *(Screens: 04-register, 05-login.)*

**D7 — (Minor, verify) Base viewer sizing for RTL/first paint.** *(See "where D1–D7 landed" below.)* In the base pdf.js viewer the Hebrew RTL page appeared small and clipped near the top at load under "Automatic Zoom"; the custom Annotate overlay renders the same document perfectly right-aligned. Likely a first-paint zoom/scroll artifact rather than a true defect — worth a quick check on initial fit-to-width. *(Screens: 15-workspace-viewer vs 17-panel-annotate.)*

### Design items D1–D7 — where they landed

*(Added 2026-08-22. The seven design findings were never tracked to resolution as a set — the code items had a remediation prompt and these did not. They were answered, but by the **2026-08-06 redesign** rather than by a patch, which is why nothing here says "fixed in commit X". Each is now a rule in `docs/design/design-instructions.md`, which is the contract every later UI change is validated against — a stronger outcome than a fix, because a rule cannot regress silently.)*

| # | Where it landed |
|---|---|
| **D1** primary-button colour inconsistent | §1 principle 3 — **one accent, used like a seal**: vermilion appears only on the logo seal, the single primary action of a screen, focus rings, selection marks and completion stamps. "If vermilion is on screen twice with no reason, that is a bug to fix." The green "Finish signing" and the indigo/lavender split are both gone: §3 Ceremony now specifies *"**Finish signing** vermilion primary"* and *"**Agree and continue** vermilion primary"*, and §3 `.seg` selected state is an **ink stamp, not accent**, precisely so the accent stays reserved. |
| **D2** dashboard shows uploads twice | §3 Dashboard — the file-card grid carries "the **D2 rule**"; the transient uploading/converting rows are their own row type above the grid and resolve into cards rather than sitting beside them. |
| **D3** two stacked toolbars | §3 Workspace — **"the workspace bar is the single owner of every editing affordance — defect D3"**. The pdf.js toolbar is cut by visibility config to zoom, page nav and find. Explicitly hidden: pdf.js download, print, open-file, rotate, draw/ink, text, stamp, presentation, scrolling/spread menus and the sidebar toggle. Rotate lives only in Organize, download only in our bar, annotation only in Annotate. |
| **D4** 24 undifferentiated landing cards | §3 Landing — **six kicker-headed groups** (Organize 7 · Edit & annotate 4 · Convert & OCR 6 · Optimize & review 3 · Protect 3 · Sign 1) of icon+name cards, plus a **type-to-filter** input that filters by name and synonyms, hides empty groups and shows a calm empty line. The filter is one of the two additions the redesign sanctioned. Superseded in detail by the compact landing (2026-08-10), which kept both. |
| **D5** disabled primary buttons unreadable | §3 — **one** disabled treatment everywhere (dashed `--color-border-strong`, `--color-ink-muted`, `cursor: not-allowed`), and §6's contrast table pins it: *disabled btn text: ink-muted on bg — **6.3:1** light / **8.8:1** dark, ≥3 ✓ **(D5 resolved)***. |
| **D6** auth pages bare | §3 Auth — a **slim header (brand + toggle), "the way home, defect D6"**, a 44 % brand panel with "← Back to the tools", and §3 fields: password fields get a **44×44 px visibility toggle inside the field and an inline rules hint (defect D6)** — so the first feedback is no longer a post-submit rejection. |
| **D7** RTL/first-paint sizing | §3 Workspace — **"First paint rule (defect D7): initial zoom fit-to-width, content centered, backdrop `--color-canvas-backdrop` — for every page size and for RTL documents; no small-and-clipped first render."** Confirmed live in the 2026-08-20 sweep: RTL mirrors correctly, including Hebrew in a text box. |

---

## 5. Code review (`/engineering:code-review`)

Findings carry an ID, severity, and a **verification status**: **CONFIRMED** (traced end-to-end in the source, and where noted re-verified by hand or reproduced live during this pass) or **PLAUSIBLE** (correct by code reading, but the triggering condition needs a runtime/topology it wasn't possible to stage here).

### 🔴 High

#### H1 — Per-IP throttles are unreliable as shipped: `NUM_PROXIES` doesn't match the prod topology (and the dev config is fully spoofable)
**CONFIRMED.** `config/settings/base.py:178` (`NUM_PROXIES=1`), `apps/core/throttling.py` (all scopes key on `get_ident`), `frontend/nginx.conf:47`, `infra/.env.prod.example:20`.

DRF's `get_ident` and `apps/core/authentication.py::client_ip` take the hop `NUM_PROXIES` back from the end of `X-Forwarded-For`. That is correct **only** when exactly that many trusted proxies append the chain. Two problems:

- **Production (verified by config):** `nginx.conf` uses `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` and its own comment states "the TLS terminator is the reverse proxy in front of this" — i.e. the real path is **client → TLS terminator → nginx → gunicorn (two hops)** while `NUM_PROXIES=1`. With one-too-few proxies counted, `hops[-1]` is always the address nginx saw connecting (the TLS terminator), which is **identical for every visitor**. Every per-IP limit — `auth` (anti-brute-force), `verify`/`verify_hour`, `public_sign`, `image_upload`, `client_error`, and the IP leg of the guest throttle — collapses into one global bucket. Consequence: a single attacker making 10 failed logins/min exhausts the shared `auth` bucket and **locks out everyone's login** (a global DoS), and legitimate per-client isolation is lost.
- **Dev (reproduced live):** with `runserver` and no proxy, the header is fully client-controlled. After `127.0.0.1` hit the `client_error` 20/hour cap (`429`), rotating `X-Forwarded-For` returned `204` again; same on the expensive `verify` 10/min endpoint.

**Fix:** set `NUM_PROXIES` to the true hop count for the deployed topology (2 for the documented one), or terminate identity at nginx with the `real_ip` module (`set_real_ip_from` the terminator, `real_ip_header X-Forwarded-For`) and count from there; then pin the effective client-IP derivation in a test so the topology and the number can't silently drift. *(Related but distinct from M1/B-SEC-2, which is a different helper.)*

#### H2 — Per-tier page cap (`max_pages`) is not enforced on the new-version write path
**CONFIRMED (re-verified by hand).** `apps/documents/tasks.py:172` (`_save_new_version`) vs `:134` (`_create_document_from_bytes`) and `apps/documents/services.py:56` (`ingest_pdf`).

The page cap §17 calls load-bearing is enforced on two of the three routes into the library (upload and new-document creation) but **not** on the third — every version-producing operation. `_save_new_version` computes `pages` via `_measure(...)` but only calls `L.enforce_storage(...)`; the sibling `_create_document_from_bytes` right above it does `if pages > limits.max_pages: raise …`, and `_save_new_version` omits exactly that block. Compounding, the page-list schema `_PAGES` (`apps/pdf_engine/schemas/__init__.py:7`) has `minItems: 1` and **no `maxItems`**, and `DUPLICATE_PAGES = DELETE_PAGES` uses it.

**Failure scenario:** a guest at the 300-page cap sends `duplicate_pages` with `pages=[0..299]` → 600 pages; the write path accepts it (storage only). Duplicated pages share content xrefs so the blob stays tiny — the storage quota does **not** bound page count — so repeating (600 → 1200 → 2400 …), or using `insert_blank` (blank pages compress to ~nothing), yields a 100k+-page document under the 200 MB quota within a dozen ordinary ops. Every later operation on that document then runs to the lane time limit and burns a shared worker — precisely the cost the cap exists to bound.

**Fix:** mirror the sibling's check in `_save_new_version` (the `pages` value is already in hand); defensively add `maxItems` to `_PAGES`. `apps/documents/tests/test_version_quota.py` covers only the storage quota on this path — add a page-cap test.

#### H3 — Image decompression-bomb DoS in signature normalization (decode-before-check; public path uncapped)
**CONFIRMED (re-verified by hand).** `apps/pdf_engine/engine/signatures.py:42` (`_open_image`), reached from `apps/esign/views.py` public field-fill (`raw = _decode_data_url(request.data.get("signature_image"))` → `SG.normalize_signature(raw)`, **no byte cap**) and the account path `_signature_png` (byte-capped at the tier limit and 12 MB).

`_open_image` calls `fitz.Pixmap(data)` — which fully decodes and allocates `w*h*n` bytes — **before** the `pixmap.width * pixmap.height > MAX_SIGNATURE_PIXELS` guard runs. A ~1–4 MB PNG of zeros encodes a 40000×40000 image (~2.9 GB RGB / ~6.4 GB RGBA), allocated in the **API process**, where none of §12's per-worker memory limits apply; the OOM killer takes the worker before the guard is reached. The project already solved this class for the *other* upload path — `apps/core/assets.py::header_dimensions` reads dimensions from the PNG/JPEG header without decoding, with a 40000×40000 regression test — but the signature path doesn't use it. The byte cap on the account path doesn't help because a small file still decodes huge; the public ceremony path (reachable by any invited external signer after consent) has no byte cap at all.

**Fix:** add a header-dimension pre-check (reuse `assets.header_dimensions`) in `_open_image`/`normalize_signature` before the first `fitz.Pixmap`, refusing when `w*h > MAX_SIGNATURE_PIXELS` or the header is unparseable; and add an explicit byte cap to the public field-fill view.

### 🟠 Medium

#### M1 — Signing/consent/abuse IP is derived from the client-controlled leftmost `X-Forwarded-For`
**CONFIRMED.** `apps/esign/models.py:421` (`client_ip`) — `forwarded.split(",")[0]` takes the leftmost (attacker-supplied) hop, unlike the `NUM_PROXIES`-aware helper in `apps/core/authentication.py`. This value is written into every hash-chained `AuditEvent`, `recipient.consent_ip`, and `AbuseReport.ip`, and is **printed on the certificate of completion** ("from where"). A signer can therefore make the certificate and audit trail attest a consent/signature from any address they choose (the HMAC chain protects against post-hoc DB tampering, not a forged value supplied at write time), and an abuser can misdirect the IP staff use to correlate reports. Bounded (a signer only misattributes their *own* action; throttle keys use the safe helper), hence Medium — but it undermines the evidentiary value the product sells. **Fix:** use `apps.core.authentication.client_ip`; optionally record the raw chain in metadata but attest the trustworthy hop.

#### M2 — `doc_lock` runs its critical section even when the lock wasn't acquired, and the lock TTL is shorter than a heavy op
**CONFIRMED (code) / PLAUSIBLE (data-loss trigger).** `apps/documents/tasks.py:60`; `DOC_LOCK_TIMEOUT=120` (`base.py:327`) vs heavy hard limit 900 s. On `acquire()` timeout the code returns `False` but still `yield`s and mutates with no mutual exclusion (only `release` is guarded by `acquired`). And the 120 s value is both the blocking wait *and* the TTL, so on a heavy op (`ocr`/`redact`/`compress`) the lock **self-expires mid-op** and a second op acquires it and runs concurrently. If two writers reach `_save_new_version` together they can compute the same `seq` and one overwrites the other's blob while losing the `unique(document, seq)` insert — leaving a `DocumentVersion` whose recorded `sha256`/`size` describe bytes that are no longer the stored blob. **Fix:** fail closed on acquire failure; raise the TTL above the heavy hard limit or renew it (watchdog/auto-extend).

#### M3 — Stalled-job reaper ages on `created_at`, false-failing backlogged jobs; completion can resurrect a reaped job
**CONFIRMED (code) / PLAUSIBLE (load trigger).** `apps/jobs/tasks.py:57` filters `status in (QUEUED,RUNNING) AND created_at < now-30min`. `created_at` includes queue-wait, so a job that sat in a healthy backlog longer than 30 min is marked **FAILED** with "The job stopped responding" while it was merely waiting — plausible on the 2-worker `heavy` lane under a burst. Compounding, `run_operation` re-checks only `CANCELED` (not `is_terminal`) before `mark_succeeded`, so a still-running job the reaper flipped to FAILED can later overwrite FAILED→SUCCEEDED, briefly corrupting the concurrency-slot count. **Fix:** measure RUNNING jobs from `started_at` (fall back to `created_at` only for never-started rows); re-read status under the lock before `mark_succeeded` and abandon if no longer RUNNING.

#### M4 — `finalize_sign_request` isn't resumable after it commits COMPLETED: a mid-finalize kill permanently loses the certificate, completion audit events, and emails
**CONFIRMED (re-verified by hand).** `apps/esign/tasks.py:99` short-circuits on `status == COMPLETED`; the atomic block commits COMPLETED at `:142`; the certificate build, `seal_applied`/`completed` audit events, and completion emails all happen **after** the commit (`:148–157+`). This runs on the `heavy` lane (600/900 s limits) with `acks_late`, so a hard-kill/OOM after the commit but before the certificate → redelivery hits `:99`, returns `{"already": True}`, and never builds the certificate or notifies anyone. The envelope is permanently "completed" with `certificate_key=""`, so `certificate` downloads answer "not ready yet" **forever**. **Fix:** make the tail idempotently resumable — on re-entry with `COMPLETED and not certificate_key`, rebuild the certificate, emit any missing `completed` event (guard each `record()` with an existence check), and re-send notifications.

#### M5 — SSRF layer-2 (Gotenberg deny-list) omits ranges layer-1 blocks; redirects/rebinds reach them
**CONFIRMED (regex) / PLAUSIBLE (end-to-end; Gotenberg not running).** `config/settings/base.py:355` (`GOTENBERG_DENY_LIST`) vs `apps/core/urlguard.py` `EXTRA_FORBIDDEN_NETWORKS`; `apps/pdf_engine/engine/convert.py::url_to_pdf` validates only the typed URL, then lets Chromium follow redirects checked solely by the deny-list regex. Verified programmatically that layer-1 blocks but the regex **misses**: `100.64.0.0/10` (CGNAT), `198.18.0.0/15` (bench), `192.88.99.0/24` (6to4), and `64:ff9b::/96` (**NAT64**). The sharp case: on an IPv6/NAT64 network, a redirect to `http://[64:ff9b::a9fe:a9fe]/` reaches the **169.254.169.254** metadata endpoint and layer-2 never sees it. **Fix:** add these ranges to the deny-list, or (better) resolve-and-range-check each redirect hop server-side instead of relying on a URL-string regex.

#### M6 — The documented layer-2 mitigation for DNS rebinding doesn't actually mitigate it
**PLAUSIBLE (contradicts the code's own claim; needs controllable DNS + Gotenberg to demo).** `apps/core/urlguard.py:13` and the compose comments claim the per-navigation deny-list covers DNS rebinding. But the deny-list matches the **URL string**, not the resolved IP, so a stable hostname that resolves public at `check_url` time and private at Chromium-fetch time produces a string that matches nothing and connects to the rebinding target (any private address, including metadata/RFC1918). The rebind window exists by construction (two resolutions, seconds apart, in different containers). **Fix:** the only real fix is resolve-and-pin the IP and validate every hop's *address* on the fetcher (custom resolver / IP allowlist), not a URL regex. At minimum, correct the comment so the residual risk is stated honestly.

#### M7 — Workspace renders a blank page when the document fails to load
**CONFIRMED.** `abstraction/viewer.facade.ts:25`, `features/workspace/workspace.html`. `ViewerFacade.load()` subscribes to `docsSvc.get(id)` with **no error handler** and no `loading`/`error` signal, and the template is gated on a truthy doc with **no `@else`**. So a 404 (a stale/foreign `/app/doc/:id`), a 500, or an offline error leaves `_doc` null, the RxJS error is swallowed, and the user sees a blank white screen with no message and no recovery (not even a loading spinner during the normal fetch). **Fix:** add `loading`/`error` signals to `ViewerFacade`, set `error` in the `get()` error callback, and render an `@else`/error branch with a message and a "back to dashboard" CTA.

### 🟡 Low

| ID | Title | Status | Location |
|---|---|---|---|
| L1 (FE-3) | "Run demo job" debug button ships in the prod dashboard; the endpoint is `DEBUG`-gated so it **404s in prod** → the button is not just dead code, it errors for any user who clicks it (§20 DoD "no dead code" violation) | CONFIRMED (seen live) | `features/dashboard/dashboard.html:60`, `dashboard.ts:264`, `apps/jobs/views.py:92` |
| L2 (FE-2) | Signing account-gate shows generic copy — routes pass `accountReason:'signing'` but the register `REASONS` map is keyed `'sign'`, so the highest-intent conversion moment falls back to "use this feature" | CONFIRMED | `app.routes.ts:57,64`, `features/auth/register.ts:12` |
| L3 (B-ENG-5) | Concurrency-slot check is a count-then-create TOCTOU → racing POSTs exceed `max_concurrent_jobs` | CONFIRMED | `apps/documents/views.py:85` |
| L4 (B-ENG-6) | Duplicate `signed` audit event on a truly simultaneous `/complete` double-submit (idempotency reads stale in-memory status) | PLAUSIBLE | `apps/esign/routing.py:95` |
| L5 (BUG-4) | Fixed-window quota counters (calendar buckets) allow a 2× burst at the window boundary — incl. the per-document password-attempt clamp (10 tries in ~1 s vs 5/min intent) | CONFIRMED | `apps/core/limits.py:181,357` |
| L6 (B-SEC-5) | `accepted_tos_at` is client-writable — it's in `fields` but not `read_only_fields`, so `PATCH /api/users/me/` can clear the ToS-consent timestamp | CONFIRMED | `apps/users/serializers.py:17,21` |
| L7 (FE-9) | In-memory document passwords (`DocumentPasswords` map) aren't cleared on logout | CONFIRMED | `core/services/document-passwords.ts`, `abstraction/auth.facade.ts:84` |
| L8 (FE-6) | Job-polling subscriptions aren't tied to component lifecycle → stale success toast + redundant reload after navigating away mid-job | CONFIRMED | `abstraction/jobs.facade.ts`, `features/workspace/workspace.ts:338` |
| L9 (FE-7) | A failed thumbnail is indistinguishable from a loading one (same `…`) and never retries — a 429 leaves a permanent placeholder | CONFIRMED | `shared/pdf-thumbnail.ts:82` |
| L10 (FE-8) | The PDF viewer fetches bytes outside `HttpClient`, so an access token expiring exactly mid-view isn't refreshed until another API call self-heals it | PLAUSIBLE | `features/workspace/workspace.ts:122` |
| L11 (FE-4) | Post-registration redirect passes an unvalidated `next` to `navigateByUrl` (Angular won't do external nav for a normal URL, but protocol-relative/backslash forms are fragile) | PLAUSIBLE | `features/auth/register.ts:108,121` |
| L12 (FE-5) | Login ignores `next` and the register→login link drops `next`/`reason`, so a deep-linked returning user lands on the dashboard instead of their destination | CONFIRMED | `features/auth/login.ts:50`, `register.ts:66` |
| L13 (B-SEC-3) | `ALLOWED_HOSTS` defaults to `*` and `prod.py` doesn't override it (limited impact — outbound URLs come from settings — but inconsistent with the codebase's fail-closed stance) | CONFIRMED | `config/settings/base.py:19` |
| L14 (B-SEC-4) | Registration reveals whether an email already has an account (mitigated by captcha + 10/min throttle) | CONFIRMED | `apps/users/serializers.py:38` |
| L15 (BUG-5) | Dead Celery `debug_task` scaffold with a bare `print` | CONFIRMED | `config/celery.py:62` |

---

## 6. Bughunt (adversarial cross-stack pass)

The bughunt's findings are folded into §5 where they overlap the structured review (H1/BUG-1, M5/BUG-2, M6/BUG-3, L5/BUG-4, L15/BUG-5). Beyond confirming those, the pass **verified a large set of seams as correct**, which is worth recording because it narrows where risk actually lives:

- **urlguard's typed-URL guard is solid** — blocks decimal/hex/octal/short-form/IPv6/NAT64/userinfo/trailing-dot/uppercase encodings; no layer-1 bypass found. (The gaps are all layer-2/redirect, M5/M6.)
- **Guest throttle "stricter of (token, IP) wins"** is correctly implemented (both classes present, same scope, distinct keys).
- **All seven retention sweeps** (`guest_purge`, `exports_purge`, `trash_purge`, `job_params_purge`, `jobs_purge`, `sign_reminders`, `sign_expirations`) are **both scheduled and implemented non-noop**, and the numbers in `frontend/src/app/core/retention.ts` match the Django settings and the `/api/config/` payload the legal page reads. No drift.
- **Token flows** — email-verification (signed user-id, 48 h TTL, idempotent), unsubscribe (keyed HMAC of the address; **GET redirects only, POST suppresses** — RFC 8058, no CSRF-via-link), public-sign (256-bit) — all correct.
- **Migrations** form a consistent cross-app DAG, `makemigrations --check` is clean, NOT-NULL columns backfill before constraints, idempotent from zero.
- **Consent/ads** fail safe (no region → ask; ads-off leaks no client-id/slots; `ads.txt` renders cleanly with an empty publisher id).
- **Frontend↔backend contract** — status enums, field names, and the `{error:{code,message,details}}` envelope match. No drift.

---

## 7. Adversarial review of this report (verification against the actual code)

Every High and most Mediums were independently re-checked against the source (and the running app) rather than taken on the reviewers' word. Results:

- **H1/BUG-1 — reframed and upheld.** The two backend passes appeared to disagree (one said throttles are *not* spoofable because `NUM_PROXIES` is set; the other proved a *live* bypass). Both are right in their context: DRF's `get_ident` is safe **only if the real hop count equals `NUM_PROXIES`**. Reading `nginx.conf` (its own comment names a TLS terminator in front) plus `NUM_PROXIES=1` shows the shipped topology is **two hops vs one counted** → all clients share one bucket in production. So the serious, confirmed issue is a **topology/config mismatch (global-bucket lockout DoS)**, and the "live spoof" is the dev manifestation. The report presents it that way rather than as simple attacker-controlled spoofing in prod.
- **H2 — upheld verbatim.** Confirmed `_save_new_version` measures `pages` but only calls `enforce_storage`, both sibling ingest paths do check `max_pages`, and `_PAGES` has no `maxItems`.
- **H3 — upheld, sharpened.** Confirmed `_open_image` decodes before the pixel check, the account path's byte cap doesn't defend against a bomb, and the **public** ceremony path has no byte cap at all.
- **M5/BUG-2 — upheld by execution.** Compiled `GOTENBERG_DENY_LIST` and ran `check_url` over each target: layer-1 blocks all four ranges, layer-2 misses all four (incl. the NAT64→metadata case). Reproduced, not asserted.
- **M1, M4, L1, L2, L6 — upheld verbatim** by direct reads (the esign `client_ip` leftmost-hop; the finalize COMPLETED short-circuit before certificate build; the demo button + its `DEBUG`-gated 404; the `'signing'`≠`'sign'` key mismatch; `accepted_tos_at` absent from `read_only_fields`).
- **FE-3 nuance added:** the demo endpoint 404s in prod, so the shipped button is *actively broken* there, not silent dead code — strengthens the "remove it" recommendation.

**No findings were dropped as false positives.** Confidence is marked per-item (CONFIRMED vs PLAUSIBLE); the PLAUSIBLE items (M6 DNS rebind, L4 concurrent double-submit, L10/L11 timing/redirect) are correct by code reading but need a runtime/topology that couldn't be staged in this sandbox, and are labeled as such rather than overstated. The one e2e failure was run down to a headless-browser artifact and explicitly excluded from the defect list.

---

## 8. What's done well (keep)

- Single ownership choke-point (`principals.py`) on every id-bearing route, including the worker layer; resolver-walking isolation sweep + guest-isolation tests. **No IDOR, no auth bypass.**
- Redaction genuinely removes content (glyph + image-pixel excision + a re-extraction verification pass); sanitize garbage-collects after unlinking.
- HMAC-keyed, append-only e-sign audit chain with a `select_for_update` fork guard; 256-bit public-sign tokens; scoped signer fields.
- SSRF defended in depth (layer-1 resolve-then-check is comprehensive; the gaps are only in the layer-2 redirect regex).
- No frontend XSS sinks; single-flight token refresh; credentials in headers, never URLs; crash reports redact tokens/emails; SSR is build-time-prerendered anonymous pages only.
- Retention promises are actually scheduled *and* implemented, with a test asserting the legal copy matches the beat config.
- Honest, careful e-sign ceremony UX and disclosure.

---

## 9. Prioritized remediation list

**Ship-blockers (do before exposing to real users/data):**
1. H1 — correct `NUM_PROXIES` / nginx `real_ip` so per-IP throttles work in prod; pin with a test.
2. H2 — enforce `max_pages` in `_save_new_version` (+ `maxItems` on `_PAGES`).
3. H3 — header-dimension pre-check before decoding signature images; byte-cap the public field-fill.
4. L1/FE-3 — remove the "Run demo job" button + `JobsService.demo()` (endpoint already prod-gated).

**High-value correctness/security (next):**
5. M1 — use the safe `client_ip` for signing/consent/abuse evidence.
6. M4 — make `finalize_sign_request` resumable after COMPLETED.
7. M2 — `doc_lock` fail-closed + TTL > heavy-op runtime.
8. M3 — reap on `started_at`; re-check terminal state before `mark_succeeded`.
9. M5 — add the four ranges to the Gotenberg deny-list (and file M6 as a tracked architectural limitation with an honest comment).
10. M7 — workspace error/loading/empty states.

**Polish (batchable):** L2–L15 and the design items D1–D7 (start with D1 primary-button system, D2 dashboard duplication, D3 pdf.js toolbar, D5 disabled-button contrast — the cheapest, highest-visibility consistency wins).
