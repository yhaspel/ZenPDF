> **Executed 2026-08-23 — historical.** Run on branch `fix/backend-debt-2026-08` (prompt 4 of the handoff programme). Seven of its eight queue rows are closed with evidence in `development-plans/PROGRESS.md`, session log **"2026-08-23 (later still, backend)"**; the eighth — the trashed document under a signature request — has its UI half done and stays open for the owner's product decision, which is what it always asked for. Browser evidence: `docs/reviews/evidence/backend-debt/`.
>
> **Every instruction in this prompt was carried out. One of its stated *facts* was false, and two of its steps needed more than they specified in order to run at all.** *(This paragraph replaces an earlier one of mine that said "three of its instructions were wrong and were not followed as written" — sloppy, and wrong twice over: §6 and §7 were both followed as written. The imprecision misled a reader within the hour, which is the whole argument for fixing it.)*
>
> **(1) §4's parenthetical is false, and §4 told me so.** It reads "saved signatures live elsewhere — *confirm in `esign/models.py` `SavedSignature.storage_key` before you rely on it*", and requires "saved-signature keys are never touched". §13 puts `SavedSignature.storage_key` in the very prefix being swept. The confirmation was made and the requirement met; the instruction anticipated its own error and was followed exactly. Trusting the parenthetical would have deleted a stored image of somebody's signature and failed §4's own named test.
>
> **(2) §6's prescribed check cannot observe what it names — and was run anyway.** `curl -sI http://localhost:4200/api/config/` with the api stopped returns `HTTP/1.1 500`, `text/plain`, and no security headers: :4200 in the compose stack is the Angular dev server, and nginx is not in the dev stack at all. The header block §6 asks to be pasted into PROGRESS comes from a probe that drives the genuine 502 → `@api_unavailable` path through the real config. Both results are in the queue row.
>
> **(3) §7 was implemented exactly as written** — the test lives at the named path, under the named function, parsing `infra/railway/api.Dockerfile` for the value. It needed one enabling change to be able to run: the api container mounted `backend/` and nothing else, so the named test could not open the named file. `infra/railway/` is now mounted read-only at the repo's own path. Nothing was copied into `backend/`; a second copy of that number is the defect §7 exists to remove.
>
> Kept as written below, for the reasoning.

# Handoff — Backend debt batch: the counters that can lie, the append that fails silently, the reconciler that never existed, and the proxy count nobody writes down (2026-08-21, revision 2 after Phase 12)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** `fix/backend-debt-2026-08`. **Depends on:** `handoff-to-cli-e2e-gate-hardening.md` merged (so the gate restarts workers, refuses skipped suites, and host-side `ng test`/`ng build` work on this node-25 Mac).
**Source of truth:** `docs/reviews/status-review-2026-08-21.md` §3.2 items 11–12, §3.3, §5.1 item 4; PROGRESS Human review queue rows: "`record_password_failure`'s incr-then-set fallback can lose a count" (2026-08-04), "The concurrency-slot race is closed on Postgres and unprovable on SQLite" (2026-08-04), "`usage_recompute` has never existed" (2026-08-02), "A completed signature can silently fail to land on the source document" (2026-08-02), "Account-side cleanup of `uploads/…` image assets" (2026-08-01), "A document under a signature request outlives the 30-day trash promise" (2026-08-02), plus the two rows the docs-reconciliation prompt added for `NUM_PROXIES` and `@api_unavailable`.
**Deploys on merge?** Yes — `backend/**` rebuilds the Django five; `infra/railway/**` rebuilds everything.

---

```text
You are closing seven backend rows that have been open since August 1–4 and were
re-verified as still open on 2026-08-21. Read AGENTS.md, development-plans/01-architecture.md
§9, §11, §13, §15, §16, §17, §21.2/§21.5 (ownership goes through apps/core/principals.py —
the grep test will fail your build otherwise), docs/reviews/status-review-2026-08-21.md
§3.2–§3.3, and every queue row named in this file's header. Then read the code you will
touch before designing anything: apps/core/limits.py (:360–390), apps/core/assets.py,
apps/core/tasks.py, apps/documents/views.py (:100–130 `_concurrency_slot`),
apps/documents/tasks.py (`bump_storage`, `_save_new_version`, `_create_document_from_bytes`,
`_save_export`), apps/esign/tasks.py (:171–261), apps/esign/models.py, apps/users/privacy.py,
infra/test.sh (`--pg`), frontend/nginx.conf (:85–91), infra/railway/nginx.railway.conf
(:56–63), infra/railway/api.Dockerfile, backend/config/settings/base.py (`NUM_PROXIES`).

## 0. Preflight

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain && git switch main && git pull --ff-only origin main
    ./infra/up.sh && docker compose -f infra/docker-compose.yml restart worker-default worker-heavy worker-render beat
    git switch -c fix/backend-debt-2026-08

TRACKING: in docs/reviews/handoffs/TRACKING.md set row 4 to
`🔵 in progress — `fix/backend-debt-2026-08`, <today>` (Status column) and put the branch name in
the next column; include that edit in your FIRST commit on the branch. Touch no other row.

PROGRESS session-log entry opened; the rows set to 🔵.

## 1. `record_password_failure` cannot lose a count

`limits.py:376–383`: `cache.incr(key)` → `except ValueError: cache.set(key, 1, …)`. Two
concurrent misses on a cold bucket both fall into `set`, and the second overwrites.
Replace with `cache.add(key, 0, timeout)` followed by `cache.incr(key)` (Redis `SETNX`
+ `INCR` — atomic per call; `add` is a no-op when the key exists). Keep the ten-second
buckets and the sliding window exactly as L5 specified. Tests in
`apps/core/tests/test_race_and_window_polish.py`: two "concurrent" cold misses through a
cache stub whose `set` would overwrite count 2; the window arithmetic unchanged (the
existing four tests keep passing).

## 2. A finalize that could not land on the source document tells the owner

`esign/tasks.py:256–261` swallows every exception into a warning and the owner learns
nothing. Add `SignRequest.source_append_error` (text, null; migration `esign/0007_…`),
written with the exception's user-safe message when `_append_to_source_document`
declines (quota, page cap, lock, engine error) and cleared when a later resume succeeds
(`_finalize_tail` already re-runs the append when `source_appended_at` is null — keep
that idempotency). Expose it read-only on the owner's request detail serializer; the
owner UI (`features/sign/request-detail*`) shows one line under the status in the
contract's notice style (§3 — read the sheet/notice spec; both themes): "The signed copy
could not be added to your document: <reason>. The sealed file and certificate are
unaffected — download them here." with the existing download links. Tests:
`apps/esign/tests/test_finalize_resume.py` (append refused by quota → field set,
envelope still completed, certificate still produced; later resume with room → field
cleared and version appended), serializer test, a component spec for the notice, and
the e2e `phase-8.spec.ts` two-signer flow asserting the notice is ABSENT on the happy
path (so a regression that always sets it is caught). OpenAPI: `spectacular
--fail-on-warn` 0/0.

## 3. `usage_recompute` exists

§15 named it; nothing implements it; `enforce_storage` refuses on the counter it would
heal. Write `apps/core/tasks.py::usage_recompute` (daily 02:00 beat entry, and a
management command `recompute_usage [--principal <id>] [--dry-run]`) that recomputes
`storage_bytes_used` for every `User` and every live `GuestSession` from what is actually
charged: every `DocumentVersion.size_bytes` of documents they own (trashed included —
trash still counts until purge; check `views._purge` to confirm), plus assets under
`uploads/{u|g}/<principal>/` (`assets.py` — blobs have no rows, so list the prefix and sum
sizes), plus live exports under `exports/{job_id}/` charged to their jobs (mirror
`jobs_purge`'s refund logic so the two agree). It writes with `F()`-free absolute updates
inside `select_for_update` where available, logs every drift ≥ 1 KB with the before/after,
and never touches a principal with a running job (the counter is mid-flight). Tests
(`apps/core/tests/test_usage_recompute.py`): drift injected upward and downward is healed;
a principal with a running job is skipped and reported; guest and user both covered;
claim-then-recompute agrees with `test_claim.py`'s expectations; purge-then-recompute
agrees with `guest_purge`. Amend §15 and the queue row.

## 4. An account's stale `uploads/…` assets are swept

`purge_principal_assets()` runs only for guest purge and account deletion. Add
`account_assets_purge` (daily): for each user, delete blobs under `uploads/u/<id>/`
older than `ASSET_RETENTION_DAYS` (default 7 — §13 calls these ephemeral; stamps and
watermarks are re-uploaded per session by design, saved signatures live elsewhere —
confirm in `esign/models.py` `SavedSignature.storage_key` before you rely on it), refund
the bytes, and log counts. The storage backend's `list_prefix` returns last-modified —
check both backends (filesystem + S3) expose it; add it if only one does. Tests: old
blobs go, fresh ones stay, saved-signature keys are never touched, bytes refunded
exactly once. Settings + `infra/.env.example` + §15/§19 amended.

## 5. The concurrency slot, proven on Postgres

`documents/views.py:106–128` takes `select_for_update` on the principal row when the
backend supports it; the hermetic suite runs SQLite and proves the path, not the lock.
Add `apps/core/tests/test_concurrency_pg.py` under the existing `@PG_ONLY` marker: with a
guest (`max_concurrent_jobs=1`), two threads POST an operation simultaneously against
the Postgres test database; exactly one 202 and one 429 `quota_exceeded`; repeat 20
iterations. Wire it into `infra/test.sh --pg` (today that flag runs only
`test_performance.py` — widen it to a `-m pg_only` marker or an explicit list). Run it
and paste the result into PROGRESS.

## 6. The 503 carries the security headers

`frontend/nginx.conf:87–91` and `infra/railway/nginx.railway.conf:59–63`: `@api_unavailable`
adds only `Retry-After`, so nginx's replace-not-inherit semantics drop CSP/HSTS/nosniff/
frame-ancestors/Referrer/Permissions on the 503 JSON. Add the full set (copy the `/api/`
location's stricter `default-src 'none'; sandbox` policy) to both confs. Verify locally:
`docker compose stop api && curl -sI http://localhost:4200/api/config/` shows the headers
on the 503, then `docker compose start api`. Paste the header block into PROGRESS.

## 7. `NUM_PROXIES` is written down where the deployment reads it

Repo default 1 (`base.py:190`), `.env.prod.example` 2, Railway measured 3 — and nothing
under `infra/railway/` sets it, so a rebuilt Railway project would silently collapse every
per-IP throttle (the QA H1 failure). In `infra/railway/api.Dockerfile` set
`ENV NUM_PROXIES=3` with the comment from `docs/ops/railway.md:101` (a service variable
still overrides it); add `apps/core/tests/test_client_ip_topology.py::test_the_railway_image_defaults_to_the_measured_hop_count`
that parses the Dockerfile for the value (so a "simplification" back to 2 has to argue
with a test). Update `docs/ops/railway.md`, `.env.prod.example`'s comment, and §19 (the
docs-reconciliation prompt added the prose; make it match the code).

## 8. A document that cannot be deleted says so where the user looks

`views._purge` already refuses permanent deletion of a document with a sign request (the
row's first half). Surface it: the dashboard trash view's permanent-delete action renders
the API's message inline (contract §3 notice), not as a toast that fades, and the row is
not offered "Delete forever" when `has_sign_requests` is true (add the boolean to the
document serializer — read-only, additive). The product decision (keep only the frozen
version?) stays with the owner — write that in the queue row; this step only stops the
nightly retry from being the user's first and only explanation. Tests: serializer,
component spec, e2e `phase-1.spec.ts` trash flow asserting the button is absent for a
document under a request (create one via the API in the spec setup).

## 9. Gate

`ruff`, `mypy`, `manage.py check`, `makemigrations --check`, `spectacular --fail-on-warn`;
backend coverage gates (apps ≥ 85 %, pdf_engine ≥ 90 %); `npm test` (396 + yours), `ng lint`,
build + verify:prerender; `./infra/test.sh --pg --e2e` fully green on the restarted stack
(63 + your new specs, including your new `@PG_ONLY` test). Phase 12 changed no backend
file, so the 1061 / 4 baseline from 2026-08-21 still stands. Migrations idempotent from zero
(`./infra/reset.sh --yes && ./infra/up.sh` → applied; second `up.sh` → "No migrations to
apply").

## 10. UI testing via the Chrome MCP tools

On http://localhost:4200, both themes, 1280 and 390 px, console read after each step:
1. Register an account (local stack — Mailpit at :8025 for the verification link),
   upload a document, send a one-signer request to yourself, complete it from the
   Mailpit link, open the request detail: no append notice on the happy path.
   Then lower the account's storage quota via `settings.TIERS` override in
   `infra/.env` (restore afterwards), send and complete another: the notice renders with
   the quota reason and the download links work.
2. Trash the document that carries the completed request → "Delete forever" absent; the
   inline explanation renders.
3. Settings → usage: run `manage.py recompute_usage --dry-run` in the api container,
   read the log line, confirm the panel number is unchanged.
Screenshot each; one line per finding in PROGRESS. After merge, on production: open
`/api/health/`, confirm the new 503 headers by `curl -sI` against a path that 404s at the
API (not a real outage — just confirm the header set on `/api/` responses is intact and
unchanged), and that a guest upload→download round trip still works.

## 11. Record, self-archive, ship

PROGRESS: close the seven rows ✔ with evidence; Decisions log entries (why `add`+`incr`;
why the reconciler skips running principals; asset retention 7 days; `NUM_PROXIES` in the
image); §9/§15/§19 amended in `01-architecture.md`; OpenAPI clean.

    git mv docs/reviews/handoffs/handoff-to-cli-backend-debt-batch.md docs/archived/$(date +%F)-handoff-to-cli-backend-debt-batch.md

prepend the "Executed <date>" banner.

TRACKING: after the merge and the `git pull --ff-only` below, set row 4 of
docs/reviews/handoffs/TRACKING.md to `✅ merged — PR #<n> (<merge sha>), <date>, archived at
docs/archived/<date>-handoff-to-cli-backend-debt-batch.md`, fill the PR/merge column, and put the PROGRESS anchor
(your session-log heading and the queue rows you closed) in the Evidence column. Commit that
one edit directly on `main` as `docs(tracking): prompt 4 merged` and push — docs only, no
deploy, the same way `f34800f` recorded Phase 12. This is the last commit of the run — do it
before you report. (The README carries no status; the board does.)

Commit in chunks (`fix(core): …`, `feat(esign): …`, `feat(core): usage_recompute`,
`build(railway): …`, `test: …`, `docs: …`); push;
`gh pr create --base main --head fix/backend-debt-2026-08 --title "fix(backend): password-meter race, finalize append notice, usage_recompute, asset sweeper, pg concurrency proof, 503 headers, NUM_PROXIES" --body "<What / Why / Verification / Migrations: esign 0007 / Env: ASSET_RETENTION_DAYS / Risk>"`.

Self-review with four lenses — *security/isolation* (the reconciler and the sweeper walk
every principal: can either read or delete across principals? do they go through
`principals.py`?), *correctness* (the reconciler against claim/purge/export semantics —
write the counter-examples first), *ops* (a wrong recompute is a wrong quota for every
user: is `--dry-run` the default in the command? is the first production run dry?),
*regression* (throttle keys unchanged; `NUM_PROXIES` default unchanged for compose).
Fix; re-run the gate; then `gh pr merge --merge --delete-branch && git switch main &&
git pull --ff-only origin main`; production check; revert on `main` if it regresses.
Report, including the first real `recompute_usage --dry-run` output from production
(`railway run`) if you have a token — otherwise say it is owed.
```
