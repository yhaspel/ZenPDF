You are working autonomously in the **ZenPDF** repository (Django 6 + DRF + Celery/Redis + Postgres + S3 backend under `backend/`, Angular 22 frontend under `frontend/`, infra under `infra/`, Playwright e2e under `e2e/`). Your job is to implement a set of verified QA findings from a full code review, safely and completely, without regressing anything. Work through the tasks in order, committing after each one.

## Operating rules (read first)

1. **Read before you write.** For each task, open the cited file(s) and the surrounding code, and mirror the existing conventions (error classes, the §6 `{ "error": { "code", "message", "details" } }` envelope, tier limits via `apps.core.limits.for_principal`, the ownership helpers in `apps.core.principals`, signals/facades on the frontend). Do not invent new patterns where one already exists.
2. **Every behavioral fix gets a test.** Add or extend a unit/e2e test that fails before your change and passes after. Put backend tests next to the code they cover (`apps/<app>/tests/`), frontend tests as `*.spec.ts`.
3. **Keep the whole suite green.** After each task run the relevant tests; before you finish, run the full gate. Never mark a task done with a failing or skipped-for-convenience test.
4. **Do not weaken existing controls or tests.** If a change makes an existing test fail, understand why before touching the test — the test is usually right.
5. **Update `development-plans/PROGRESS.md`** with a short session-log entry per finding (id, what changed, test name), following the file's existing style. Record any decision and its rationale.
6. **Scope discipline.** Implement exactly the findings below. If you discover something new, note it in PROGRESS.md's "Human review queue" rather than expanding scope silently.
7. **Commit granularity.** One commit per finding id (e.g. `fix(throttle): H1 correct NUM_PROXIES for the 2-hop prod topology`), with the finding id in the subject.

## How to run things

Backend (from `backend/`, virtualenv active, `DJANGO_SETTINGS_MODULE=config.settings.test`):

- Tests: `pytest -q` (or a targeted `pytest apps/documents/tests/test_version_quota.py -q`)
- Lint/type: `ruff check .` and `mypy .` and `python manage.py check`
- OpenAPI must stay valid: `python manage.py spectacular --fail-on-warn --validate >/dev/null`

Frontend (from `frontend/`):

- Lint: `npm run lint` (angular-eslint)
- Unit: `npm test` (Vitest)

The repo's `infra/test.sh` orchestrates these; use it if the Docker stack is available, otherwise run the commands directly. E2E (`e2e/`) needs the running stack — run the specific spec you touch if you can, otherwise rely on unit coverage and say so in PROGRESS.md.

---

# TASKS

## H1 — Per-IP throttles: make `NUM_PROXIES` match the real proxy topology (ship-blocker)

**Problem.** DRF throttle identity (`get_ident`) and `apps/core/authentication.py::client_ip` take the hop `NUM_PROXIES` back from the end of `X-Forwarded-For`. `config/settings/base.py` defaults `NUM_PROXIES=1` and `infra/.env.prod.example` sets `NUM_PROXIES=1`, but the documented production topology is **client → TLS terminator → nginx → gunicorn = two proxies** that append/forward `X-Forwarded-For` (`frontend/nginx.conf` uses `proxy_add_x_forwarded_for` and its comment states the TLS terminator sits in front). With one-too-few proxies counted, every client resolves to the terminator's constant IP, collapsing all per-IP throttles (`auth`, `verify`, `verify_hour`, `public_sign`, `image_upload`, `client_error`, guest-IP) into a single global bucket — a login/verify lockout DoS. In `DEBUG`/dev (no proxy) the header is fully client-controlled and the limit is trivially reset by rotating `X-Forwarded-For`.

**Fix.**
1. In `infra/.env.prod.example`, set `NUM_PROXIES=2` and add a comment: the value MUST equal the number of trusted proxies in front of gunicorn that append `X-Forwarded-For` (TLS terminator + nginx = 2 in the reference topology); if a real-IP module is used at nginx instead, adjust accordingly.
2. In `config/settings/base.py`, add a comment next to `NUM_PROXIES` making the same point (do not change the code default of 1 — that is correct for a single-proxy dev/compose setup; the fix is that prod must set the true count).
3. Optionally (preferred, if you can do it cleanly): document in `frontend/nginx.conf` the `set_real_ip_from <terminator-CIDR>; real_ip_header X-Forwarded-For; real_ip_recursive on;` alternative as a commented block, so an operator can normalize the client IP at nginx and keep `NUM_PROXIES=1`.
4. **Pin it with a test** in `apps/core/tests/` (new `test_client_ip_topology.py` or extend an existing throttling test): build a request whose `HTTP_X_FORWARDED_FOR` is `"<client>, <terminator>"`, set `NUM_PROXIES=2` (via `override_settings` on `REST_FRAMEWORK`), and assert `apps.core.authentication.client_ip(request) == "<client>"` (not the terminator). Add the mirror assertion that with a spoofed prefix `"<spoof>, <client>, <terminator>"` the result is still `<client>`.

**Acceptance:** the new test passes; existing throttle tests still pass; `.env.prod.example` and settings comments explain the invariant.

---

## H2 — Enforce the tier page cap on the new-version write path (ship-blocker)

**Problem.** `apps/documents/tasks.py::_save_new_version` measures `pages` but only calls `L.enforce_storage(...)`. The sibling `_create_document_from_bytes` (same file, just above) and `services.ingest_pdf` both enforce `pages > limits.max_pages`. Because duplicated pages share content xrefs, the storage quota does not bound page count, so a guest can grow a document unbounded via `duplicate_pages`/`insert_blank` (their page-list schema has no `maxItems`).

**Fix.**
1. In `_save_new_version`, right after `sha, pages, size = _measure(data)`, add the same check the sibling uses (the imports `L`, `EngineError`, `is_guest` are already present in this module):

   ```python
   limits = L.for_principal(document.principal)
   if pages > limits.max_pages:
       raise EngineError(
           f"That would produce a {pages}-page document; the limit is "
           f"{limits.max_pages}."
           + (" Create a free account to work with larger documents."
              if is_guest(document.principal) else ""),
           code="validation_error",
           details={"pages": pages, "max_pages": limits.max_pages,
                    "tier": limits.tier},
       )
   ```

   Keep the existing `L.enforce_storage(document.principal, size)` call.
2. Defense in depth: in `apps/pdf_engine/schemas/__init__.py`, add a generous `maxItems` to `_PAGES` (e.g. `"maxItems": 10000`) so an enormous input array is rejected at validation before it reaches the engine. Do not set it so low that a legitimately large document breaks — the runtime cap above is the real enforcement.

**Acceptance:** add a test in `apps/documents/tests/test_version_quota.py` (or a new `test_version_page_cap.py`): a guest principal at/над the 300-page cap issuing `duplicate_pages` that would exceed `max_pages` gets a `validation_error` (§6 shape) and no new version is written; a within-cap op still succeeds. Existing tests stay green.

---

## H3 — Stop the image decompression-bomb in signature handling (ship-blocker)

**Problem.** `apps/pdf_engine/engine/signatures.py::_open_image` calls `fitz.Pixmap(data)` (fully decodes/allocates) **before** the `MAX_SIGNATURE_PIXELS` check, so a small PNG encoding e.g. 40000×40000 OOM-kills the API process. The public ceremony field-fill (`apps/esign/views.py::PublicSignFieldView.post`, ~line 778 `raw = _decode_data_url(request.data.get("signature_image"))` → `SG.normalize_signature(raw)`) has no byte cap at all. The project already has the correct guard elsewhere: `apps/core/assets.py::header_dimensions(data) -> tuple[int,int] | None` reads dimensions from the header without decoding.

**Fix.**
1. In `signatures.py::_open_image`, pre-check dimensions from the header before the first `fitz.Pixmap`. Use a function-local import to avoid any import cycle:

   ```python
   def _open_image(data: bytes) -> fitz.Pixmap:
       from apps.core.assets import header_dimensions
       dims = header_dimensions(data)
       if dims is None:
           raise InvalidParams("That image could not be read.")
       if dims[0] * dims[1] > MAX_SIGNATURE_PIXELS:
           raise InvalidParams("That image is too large to use as a signature.")
       try:
           pixmap = fitz.Pixmap(data)
       except Exception as exc:  # noqa: BLE001
           raise InvalidParams(f"That image could not be read: {exc}") from exc
       if pixmap.width * pixmap.height > MAX_SIGNATURE_PIXELS:
           raise InvalidParams("That image is too large to use as a signature.")
       return pixmap
   ```

   (Verify `header_dimensions` handles the formats signatures accepts — PNG/JPEG. If a supported format returns `None` from the header reader, extend `header_dimensions` rather than skipping the check.)
2. In `PublicSignFieldView.post`, add a byte cap on `raw` before calling `normalize_signature`, mirroring the account path's existing `12 * 1024 * 1024` cap in `apps/esign/views.py::_signature_png` (reuse the same limit and the same error type that path raises).

**Acceptance:** a unit test that feeds a ~1–2 MB PNG whose IHDR declares 40000×40000 to `normalize_signature` (and to the public field endpoint) is refused with `InvalidParams`/validation error and **without** allocating the full bitmap (assert it raises quickly, mirroring `apps/documents/tests/test_annotations_api.py`'s existing 40000×40000 bomb test). Existing signature tests stay green.

---

## L1 (FE-3) — Remove the "Run demo job" scaffolding (ship-blocker: dead/broken code)

**Problem.** `frontend/src/app/features/dashboard/dashboard.html` (~line 60) renders a "Run demo job" button wired to `dashboard.ts::runDemoJob()` → `core/services/jobs.service.ts::demo()` → `POST /api/jobs/demo/`. The endpoint (`apps/jobs/views.py::DemoJobView`) is `DEBUG`-gated and **404s in production**, so the button is visible to every logged-in user and errors when clicked.

**Fix.** Remove the button and its handler (`runDemoJob`), remove `JobsService.demo()`, and remove the now-unused backend `DemoJobView` + its route in `apps/jobs/urls.py` (grep for `demo` to catch the URL name and any test referencing it; delete or update those tests). Ensure nothing else imports them.

**Acceptance:** `npm run lint` clean; `ng`/vitest green; backend `pytest` green (remove/adjust any test that asserted the demo endpoint); no reference to `jobs/demo` remains.

---

## L2 (FE-2) — Fix the signing account-gate copy key

**Problem.** `frontend/src/app/app.routes.ts` passes `data: { accountReason: 'signing' }` on the two `/app/sign*` routes, but `features/auth/register.ts`'s `REASONS` map is keyed `'sign'`, so `REASONS['signing']` is undefined and the gate shows the generic fallback copy at the highest-intent conversion moment.

**Fix.** Make them agree: change both route `accountReason` values from `'signing'` to `'sign'` (preferred — matches the existing map key), OR add a `signing:` entry to `REASONS`. Then add a small test asserting every `accountReason` string used in the route table resolves to a non-fallback entry in `REASONS` (guards against future drift).

**Acceptance:** `account.guard`/register spec asserts the tailored copy; lint + unit green.

---

## L6 (B-SEC-5) — Make `accepted_tos_at` read-only

**Problem.** `apps/users/serializers.py::UserSerializer` lists `accepted_tos_at` in `fields` but not in `read_only_fields`, so `PATCH /api/users/me/` can clear/rewrite the ToS-consent timestamp.

**Fix.** Add `"accepted_tos_at"` to `UserSerializer.read_only_fields`.

**Acceptance:** a test that `PATCH /api/users/me/ {"accepted_tos_at": null}` does **not** change the stored value; existing user-serializer tests green.

---

## L15 (BUG-5) — Remove the dead `debug_task`

**Problem.** `backend/config/celery.py` (~line 62) still contains the cookiecutter `debug_task` with a bare `print`, unreferenced.

**Fix.** Delete the `debug_task` function. Confirm nothing references it.

**Acceptance:** `ruff`/`pytest` green.

---

## M1 — Use the trustworthy client IP for signing/consent/abuse evidence

**Problem.** `apps/esign/models.py::client_ip` takes the leftmost (client-controlled) `X-Forwarded-For` hop and is written into the hash-chained audit trail, `recipient.consent_ip`, and `AbuseReport.ip`, and printed on the certificate of completion. The `NUM_PROXIES`-aware helper `apps/core/authentication.py::client_ip` already exists.

**Fix.** Replace the body of `apps/esign/models.py::client_ip` to delegate to the core helper (this fixes all three call sites — `models.py:413`, `views.py:749`, `views.py:870` — at once):

```python
def client_ip(request) -> str | None:
    from apps.core.authentication import client_ip as _core_client_ip
    return _core_client_ip(request)
```

Verify the core helper's return type/None-handling is acceptable for these callers (it returns the trustworthy hop or `REMOTE_ADDR`). If you want the forensic detail, additionally store the raw XFF chain in the audit event metadata, but the **attested** IP (certificate, `consent_ip`) must be the core-derived one.

**Acceptance:** a test that a request carrying a spoofed leftmost `X-Forwarded-For` records/attests the correct proxy-derived IP, not the spoofed one. Audit-chain and certificate tests stay green.

---

## M2 — `doc_lock`: fail closed on acquire failure, and make the TTL outlast a heavy op

**Problem.** `apps/documents/tasks.py::doc_lock` (~line 60) `yield`s and mutates even when `lock.acquire()` returned `False` (only the release is guarded by `acquired`), and `DOC_LOCK_TIMEOUT=120` is both the blocking wait and the lock TTL, so a heavy op (soft/hard 600/900 s) outlives its own lock and a second op can run concurrently — risking a lost-update on the version chain.

**Fix.**
1. Fail closed: if the lock was not acquired, raise a clean error (e.g. `EngineError("The document is busy; try again.", code="locked")`) instead of proceeding, so the job fails cleanly with the §6 shape.
2. Give the lock a TTL longer than the heaviest op, or renew it. Simplest robust option: construct the redis-py `Lock` with a separate, longer `timeout` (≥ the heavy hard limit, e.g. `settings.CELERY_TASK_TIME_LIMIT`) while keeping the blocking wait bounded (`blocking_timeout=DOC_LOCK_TIMEOUT`); or add auto-extension. Keep `DOC_LOCK_TIMEOUT` as the blocking-wait knob and add a new setting for the TTL so the two are not conflated.

**Acceptance:** tests that (a) a second writer that cannot acquire the lock gets `locked`/failed rather than running, and (b) the lock TTL used is ≥ the heavy op limit. Existing job/lock tests stay green.

---

## M3 — Stalled-job reaper: age on `started_at`, and don't resurrect a reaped job

**Problem.** `apps/jobs/tasks.py::reap_stalled_jobs` (~line 57) ages `QUEUED|RUNNING` on `created_at`, so a healthy job that waited in a long backlog is falsely marked FAILED with "stopped responding". And `run_operation` re-checks only `CANCELED` (not terminal state) before `mark_succeeded`, so a reaped-then-finished job can overwrite FAILED→SUCCEEDED.

**Fix.**
1. Measure RUNNING jobs from `started_at` (fall back to `created_at` only for rows that never started, and use a generous cutoff there, or gate on the Celery task being genuinely gone). Do not fail a job purely for queue-wait time.
2. In the worker completion path (`run_operation`, before `mark_succeeded`), re-read the row under the lock and abandon if it is no longer `RUNNING` (e.g. `if not Job.objects.filter(pk=job.pk, status=Job.Status.RUNNING).exists(): return`), so a reaped job is not resurrected and the slot count stays correct.

**Acceptance:** tests that (a) a RUNNING job that only *waited* a long time is not reaped, (b) a job reaped to FAILED is not later flipped to SUCCEEDED. Existing `test_worker_limits.py` stays green (update the assertion that documented the `created_at` behavior if it now contradicts the fix, and record why in PROGRESS.md).

---

## M4 — Make `finalize_sign_request` resumable after it commits COMPLETED

**Problem.** `apps/esign/tasks.py::_finalize` commits `status=COMPLETED` inside an atomic block, then does the certificate build, `seal_applied`/`completed` audit events, source-append, and completion emails **after** the commit. The top of the task short-circuits on `COMPLETED` (`return {"already": True}`). With `acks_late` on the `heavy` lane, a kill after the commit but before the tail means redelivery returns immediately and the certificate/emails/audit are lost forever (`certificate_key=""`, downloads answer "not ready" permanently).

**Fix.** Make the post-commit tail idempotent and re-runnable:
1. Extract everything after the atomic block into a helper `_finalize_tail(sign_request)`.
2. Make each step idempotent:
   - Record `seal_applied`/`completed` only if that event doesn't already exist for this request (e.g. guard with `sign_request.events.filter(type=...).exists()` — check the actual related name/type field on `AuditEvent`).
   - Build + store the certificate only `if not sign_request.certificate_key`.
   - Guard `_append_to_source_document` so a re-run doesn't double-append (add a marker/flag or make the append itself idempotent).
   - Gate `emails.notify_completed` on a new nullable timestamp field `completed_notified_at` (add a migration), setting it after a successful send and skipping if already set.
3. Change the top-of-task `COMPLETED` branch to call `_finalize_tail(sign_request)` and return its result (so a redelivered/resumed task finishes whatever is missing) instead of blanket-returning `{"already": True}`. Also call `_finalize_tail(...)` after the atomic commit on the normal path.

**Acceptance:** a test that simulates a mid-finalize kill (e.g. run `_finalize`, then clear `certificate_key` and re-run, or invoke `_finalize_tail` twice) and asserts the certificate, the `completed` audit event, and the completion notification are each produced **exactly once** and the certificate download succeeds. Existing esign finalize/idempotency tests stay green. Include the new migration.

---

## M5 — Close the SSRF layer-2 range gap (and file M6 honestly)

**Problem.** `config/settings/base.py::GOTENBERG_DENY_LIST` (and the identical literals in `infra/docker-compose.yml` / `docker-compose.prod.yml`) is the only check on Gotenberg's redirect hops, and it omits four ranges that `apps/core/urlguard.py` blocks: `100.64.0.0/10` (CGNAT), `198.18.0.0/15`, `192.88.99.0/24` (6to4), and `64:ff9b::/96` (NAT64 — a redirect to `[64:ff9b::a9fe:a9fe]` reaches 169.254.169.254).

**Fix.**
1. Extend the `GOTENBERG_DENY_LIST` regex to also deny those four ranges, and keep the three copies (settings default, `docker-compose.yml`, `docker-compose.prod.yml`) byte-for-byte identical (there is a test — `apps/core/tests/test_urlguard.py::test_gotenberg_denies_what_layer_one_denies` — that asserts layer-2 denies what layer-1 denies; make it pass by extending both the deny-list and, if present, its expectation set). Watch the flag-parser constraints noted in the existing comments (no commas; `$$` vs `$` escaping between compose and settings).
2. **M6 (DNS rebind) is a known architectural limitation, not a quick fix.** Do **not** attempt a risky resolver rewrite here. Instead: correct the misleading comments in `apps/core/urlguard.py` and the compose files so they no longer claim layer-2 fully mitigates DNS rebinding, and add a tracked entry to `development-plans/PROGRESS.md`'s Human review queue describing the real fix (resolve-and-pin the IP / validate every hop's address on the fetcher, or an egress allowlist).

**Acceptance:** `test_gotenberg_denies_what_layer_one_denies` (or an extended version) passes for all four ranges; the three deny-list copies remain identical; comments are honest; M6 is logged.

---

## M7 (FE-1) — Workspace error/loading/empty states

**Problem.** `frontend/src/app/abstraction/viewer.facade.ts::load()` subscribes to `docsSvc.get(id)` with no error handler and no `loading`/`error` signal; `features/workspace/workspace.html` gates on a truthy doc with no `@else`. A 404 (stale/foreign `/app/doc/:id`), 500, or offline error leaves a blank white screen with no message or recovery.

**Fix.** Add `loading` and `error` signals to `ViewerFacade`; set `loading` around the `get()` call and set `error` in its error callback (map the §6 error code/message where available). In `workspace.html`, render a loading state during fetch and an `@else`/error branch with a human message and a "Back to dashboard / Start over" action. Keep the existing guest-expired (410) banner behavior.

**Acceptance:** a workspace spec that mocks a failed document `get()` and asserts an error message + recovery CTA render (no blank screen); lint + unit green.

---

## Lower-priority polish (do if time permits, one commit each; otherwise log in PROGRESS.md)

- **L3 (B-ENG-5):** make the concurrency-slot check atomic — wrap count+create in a transaction with `select_for_update` on the principal row (or a short per-principal advisory lock) so racing operation POSTs can't exceed `max_concurrent_jobs`. Test with two near-simultaneous creates.
- **L4 (B-ENG-6):** make recipient completion a conditional UPDATE — `Recipient.objects.filter(pk=..).exclude(status=COMPLETED).update(status=COMPLETED, completed_at=now)` — and only `record("signed", ...)` when it updated 1 row, so a concurrent double-submit can't write two `signed` events.
- **L5 (BUG-4):** the fixed calendar-window meters in `apps/core/limits.py` allow a 2× boundary burst; at minimum tighten the per-document password-attempt clamp (switch it to a sliding window or halve the window). Keep other meters as-is if changing them risks regressions, and note the decision.
- **L7 (FE-9):** clear the in-memory `DocumentPasswords` map on logout — add a `clearAll()` and call it from `AuthFacade.clearSession()`.
- **L8 (FE-6):** pipe workspace/tool job-tracking subscriptions through `takeUntilDestroyed()` so navigating away mid-job doesn't fire stale toasts/reloads.
- **L9 (FE-7):** give `shared/pdf-thumbnail.ts` a distinct `failed` state (separate from loading) with click-to-retry / backoff on transient statuses (esp. 429).
- **L10 (FE-8):** when the PDF viewer's out-of-`HttpClient` fetch 401s, force a token refresh and re-assign `src` (or refresh proactively before wiring the viewer).
- **L11 (FE-4):** validate the post-registration `next` before `navigateByUrl` — accept only same-origin absolute paths (reject `//host`, backslashes, schemes), default `/app/dashboard`.
- **L12 (FE-5):** have Login read `next` the way Register does, and forward `next`/`reason` on the register→login link.
- **L13 (B-SEC-3):** in `config/settings/prod.py`, require `ALLOWED_HOSTS` from the environment (raise `ImproperlyConfigured` if empty, matching the `SECRET_KEY` stance) or drop the `*` default there.
- **L14 (B-SEC-4):** decide deliberately on register account-enumeration; if you close it, return a generic success-shaped response and send an out-of-band "you already have an account" email. If you keep it, document the tradeoff in code + PROGRESS.md.

---

## Final verification (must pass before you report done)

1. Backend: `ruff check .` clean, `mypy .` clean, `python manage.py check` clean, `python manage.py spectacular --fail-on-warn --validate` clean, `pytest -q` green (coverage gates: `apps` ≥ 85%, `pdf_engine` ≥ 90% — do not drop below).
2. Frontend: `npm run lint` clean, `npm test` green.
3. If the Docker stack is available, run `infra/test.sh` (and the e2e specs you touched); otherwise state clearly in PROGRESS.md which e2e specs were not run and why.
4. `development-plans/PROGRESS.md` updated with a session-log entry per finding (id, change, test), plus any decisions and the M6 tracked note.
5. Produce a short summary: each finding id, the files changed, the test(s) added, and pass/fail of the gates above. Flag anything you intentionally deferred.

Do not tag a release or claim Phase 10 complete — the owner-executed launch checklist is out of scope. Your deliverable is the code changes, tests, and the PROGRESS.md update.
