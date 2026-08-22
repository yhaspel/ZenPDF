# Handoff — E2E and gate hardening: the node-25 guard, prove the page drew, never test stale workers, and fix the `version_conflict` flake at its source (2026-08-21, revision 2 after Phase 12)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** `fix/e2e-gate-hardening`. **Depends on:** `handoff-to-cli-docs-reconciliation.md` merged.
**Source of truth:** `docs/reviews/status-review-2026-08-21.md` (rev 2) §3.2 items 13–14, §3.3, §5.1 item 2; PROGRESS Human review queue rows "`typeof localStorage === 'undefined'` is no longer a safe \"am I in a browser\" test" (2026-08-21, `:1055`), "Nothing still asserts that a page actually drew" (2026-08-20), "The e2e suite can silently test stale backend code" (2026-08-21), "A stale `base_version_seq` after every save" (2026-08-02), "`phase-3`/`phase-4` … memory flakes" (2026-08-02).
**Deploys on merge?** Yes — `frontend/**` rebuilds `web`; `backend/**` (settings) rebuilds the Django five.

---

```text
You are closing the testing gaps that let a ten-day production defect hide (the viewer that
never drew) and let a test be misdiagnosed twice (workers running ten-day-old code). Read
AGENTS.md, docs/design/design-instructions.md (you will add one data-test attribute and
nothing visible), docs/reviews/status-review-2026-08-21.md §3.2–§3.3 and §5.1, and the five
PROGRESS Human-review-queue rows named in this file's header. Then the code you will
touch: frontend/src/app/features/workspace/workspace.{ts,html},
frontend/src/app/abstraction/viewer.facade.ts, e2e/tests/phase-1.spec.ts and
e2e/tests/helpers (if present), e2e/playwright.config.ts, infra/test.sh, infra/up.sh,
backend/config/settings/test.py and base.py (SIGNING_CERT_PATH).

## 0. Preflight

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain                       # must be clean, else stop and tell me
    git switch main && git pull --ff-only origin main
    node --version                               # 25.2.1 on this Mac — see step 0.5 before running any host-side ng command
    ./infra/up.sh
    docker compose -f infra/docker-compose.yml restart worker-default worker-heavy worker-render beat
    curl -s http://localhost:8010/api/health/    # .env overrides API_PORT=8010; expect every check true
    git switch -c fix/e2e-gate-hardening

TRACKING: in docs/reviews/handoffs/TRACKING.md set row 2 to
`🔵 in progress — `fix/e2e-gate-hardening`, <today>` (Status column) and put the branch name in
the next column; include that edit in your FIRST commit on the branch. Touch no other row.

Open a PROGRESS.md session-log entry now ("2026-MM-DD — E2E and gate hardening") and
set the five queue rows to "🔵 in progress (this branch)" in their Resolved column.

## 0.5. First: make the host gate work again (the node-25 `localStorage` row)

`frontend/src/app/core/services/token.service.ts:35` decides "am I in a browser" with
`typeof localStorage === 'undefined'`. Node 25 ships a `localStorage` global that exists
but has no `getItem` unless `--localstorage-file` is passed, so on this Mac a host
`ng test` fails 108 specs and `npm run build` fails every prerendered route with
`TypeError: e?.getItem is not a function` (PROGRESS `:1055`, `:1156`). Production and the
containers are node 24 and unaffected. Fix it properly, not with a node downgrade:
feature-detect (`typeof localStorage?.getItem === 'function'`) **or**, better, route the
decision through `isPlatformBrowser(PLATFORM_ID)` like the rest of the app; the same
`typeof localStorage === 'undefined'` guard is at `theme.service.ts:38` and
`guest-token.service.ts:22` — fix all three the same way (the `typeof window` /
`typeof document` checks elsewhere are fine: those globals are absent or whole, never
half-present). Unit test: a `localStorage` stub that is an object without
`getItem` must be treated as "no storage" (the service falls back to memory) and the
prerender path must not throw. Prove it on the host: `npm test` and `npm run build` pass
on node 25 **before** you go on — everything after this step relies on it. Close the row.

## 1. The page-actually-drew assertion

Product side (minimal, additive, contract-neutral):
- In View mode the workspace hosts `ngx-extended-pdf-viewer`. Bind its page-rendered
  output (check the library's exact output name in node_modules —
  `(pageRendered)` / `(pagesLoaded)` — do not guess) to a workspace signal `pageDrawn`
  and expose it as `data-test="viewer-drew"` on the viewer host (attribute present only
  after the first page rendered). Reset it on `viewer.load()`. No visible change; both
  themes unaffected by construction — say so in the PR, but still screenshot (step 6).
- Annotate/Edit/Forms/Protect/Sign modes draw their own raster via
  `shared/page-overlay` (an `<img>`); expose `data-test="overlay-drew"` once the raster's
  `load` event fired with a non-zero natural size.

Test side:
- `e2e/tests/helpers/drew.ts` (or extend the existing helper module): `expectPageDrew(page)`
  waits for `[data-test=viewer-drew]`, then samples the largest `canvas` via
  `page.evaluate` (`getImageData`, stride ≥ 97 px, count distinct RGB triples) and asserts
  > 3 distinct colours and width > 300 — **pixels, not status codes**. `expectOverlayDrew`
  does the same for the overlay `<img>` by drawing it onto an offscreen canvas.
- `phase-1.spec.ts` — the upload→open test calls `expectPageDrew` (this is the assertion
  the 2026-08-02 and 2026-08-10 rows asked for).
- `phase-3.spec.ts` — the guest annotate spec calls `expectOverlayDrew` before drawing.
- New `@smoke` spec `e2e/tests/smoke-viewer.spec.ts`: cold guest → `/annotate-pdf` →
  upload `text.pdf` → `?mode=view` → `expectPageDrew`. It must run against production
  unchanged (`BASE_URL=https://zenpdf.up.railway.app`): no Mailpit, no account, one
  upload, and it asserts the `.mjs` requests answered `text/javascript` via
  `page.on('response')`. Use a fresh context so the guest throttle (40/min) is not shared
  with other specs.

## 2. Never test stale workers

- `infra/test.sh --e2e`: before Playwright, `docker compose restart worker-default
  worker-heavy worker-render beat`, then poll `/api/health/` until `checks.workers` is
  true (timeout 120 s, then fail loudly). Print the worker containers' `StartedAt`.
- `infra/up.sh`: after the stack is healthy, compare each worker container's `StartedAt`
  with the newest mtime under `backend/` (excluding caches); if any worker predates it,
  print a yellow warning "worker-<q> started before the newest backend change — restart
  it" (do not auto-restart in `up.sh`; `test.sh` is the place that restarts). Note for
  the record: the Phase-12 gate passed `phase-2b:130` "now that `up.sh` has restarted
  the workers" — `docker compose up -d --build` recreates a container only when its image
  or definition changed, so that restart was incidental, which is why this step exists.
- docs/ops/release.md + docs/ops/queue-stuck.md: one paragraph each on the hazard.

## 3. The gate must not call itself green with tests skipped

- `infra/test.sh`: run pytest with `-rs`; after the run, count `SKIPPED` lines; inside
  the compose stack the only acceptable skips are the Postgres-only plan tests when
  `--pg` is not given (4). If more are skipped (Gotenberg down → 10 conversion tests),
  print the skip reasons and exit 1 with "the gate did not exercise N tests — fix the
  environment, do not ship". Add a pre-check: `docker compose exec -T api curl -sf
  http://gotenberg:3000/health` before pytest, failing fast with "restart gotenberg".
- Regression test for the guard itself is a shell check in test.sh, not pytest; document
  it at the top of test.sh.

## 4. `@quarantine` means something

- `e2e/playwright.config.ts`: `grepInvert: /@quarantine/` unless `INCLUDE_QUARANTINE=1`.
  Keep `retries: 0`. Update the header comment and docs/ops/release.md :20 to describe
  the real behaviour. There is nothing to quarantine today — do not tag anything.

## 5. The signing cert for non-compose runs

- `backend/config/settings/test.py`: if `SIGNING_CERT_PATH` is unset in the environment
  and `/certs/zenpdf-dev.p12` does not exist, default to
  `<repo>/infra/certs/zenpdf-dev.p12` (derive from `BASE_DIR`). If that is also missing,
  leave the compose default so the failure message still names the path. Add
  `apps/esign/tests/test_seal_fixture_path.py` asserting the resolver picks the repo
  copy when the compose path is absent (monkeypatch `os.path.exists`). Record in
  PROGRESS why: 14 esign/isolation tests reported as failures in every sandbox that
  lacks the Docker mount, which read like seal breakage.

## 6. The `version_conflict` flake, fixed at the source

The 2026-08-02 row measured it 2-in-6 red on `main`: after a save, `viewer.reload()`
refetches asynchronously, and anything dispatched before the GET lands carries the old
`base_version_seq`, so the worker refuses it with `version_conflict`. The status review
found the mechanism is in the receiver, not the emitters: every mode component already
emits `output<Job>()` but `workspace.html:118,127,138,149,160,170` (at `f34800f`) binds
`(saved)="onEditSaved()"` etc. without `$event`, and the handlers call bare
`viewer.reload()`. Phase 12 added a version cursor to `workspace.ts` (`versionCursor`,
`stepVersion`, `trackReload`) — `adopt()` must update `currentSeq` in a way the cursor's
`expected` arithmetic still understands (a save appends one version; a revert appends one
version), and the cursor-on-failure fix belongs to the workspace-debt prompt, not here —
keep the two changes apart.

- `ViewerFacade.adopt(job: Job)`: when `job.result` carries `seq` (and `page_count` if
  present), update `_doc` synchronously (`current_version.seq`, `page_count`) and bump a
  `versionsDirty` flag, then `reload()` for the rest. `currentSeq()` is therefore right
  the instant the save succeeds.
- `workspace.html`: pass `$event` on all six `(saved)` bindings; the six handlers and
  `trackReload()` call `viewer.adopt(job)` instead of bare `reload()`.
- Unit tests: `viewer.facade.spec.ts` (adopt updates `currentSeq` before the refetch
  resolves; a result without `seq` falls back to reload; generation guard still holds);
  `workspace-*.spec.ts` (each `(saved)` handler forwards the job).
- Prove the flake is gone: run `npx playwright test tests/phase-3.spec.ts tests/phase-4.spec.ts`
  five times each on the restarted stack; all green; paste the five results into PROGRESS.
  Then close the 2026-08-02 row and the `base_version_seq` row with that evidence.

## 7. Tests and gate

- `cd frontend && npm test` (unit), `npx ng lint`, `npm run build && npm run verify:prerender`.
- `cd backend && pytest` with coverage gates (apps ≥ 85 %, pdf_engine ≥ 90 %); ruff; mypy.
- `./infra/test.sh --pg --e2e` on the restarted stack — **must be fully green** (63 + your
  new specs; 0 skipped — the 4 `--pg` ones are now run).
- `BASE_URL=https://zenpdf.up.railway.app npx playwright test --grep @smoke` for the new
  viewer smoke only (`-g "smoke-viewer"`) — it must pass against production BEFORE your
  change (it tests the deployed site) — record the result.
- Data-test parity: two additive attributes (`viewer-drew`, `overlay-drew`), zero removed.

## 8. UI testing via the Chrome MCP tools (local stack, then production)

With the local stack up, using the Chrome MCP tools (claude-in-chrome) on
http://localhost:4200:
1. `/annotate-pdf` → upload a PDF → workspace → View: read the DOM for
   `[data-test=viewer-drew]`, screenshot the drawn page in **light and dark** (theme toggle
   in the workspace bar), at 1280 px and at 390 px (resize_window); read the console — zero
   errors.
2. Annotate mode: `[data-test=overlay-drew]` present; draw a square; save; immediately
   (within a second) rotate a page in Organize — no "Document changed — refreshed" toast
   (the race is gone); read the console.
3. Record the screenshots' findings (one line each) in the PROGRESS entry.

After merge (step 10), repeat 1 on https://zenpdf.up.railway.app once Railway reports the
`web` deploy live (poll `/api/health/` and the bundle name in the page source until it
changes), and run the production smoke again.

## 9. Record and self-archive

PROGRESS: tick the five rows ✔ with evidence (the node-25 guard with its host-run proof,
spec names, the 5× runs, the production smoke result); Decisions log entries for the
storage guard (`isPlatformBrowser` vs feature-detect), `adopt()` (why the receiver, not
the emitters), the skip guard and the `@quarantine` semantics; amend `01-architecture.md`
§18 (testing strategy) with the page-drew rule and the worker-restart rule. Then:

    git mv docs/reviews/handoffs/handoff-to-cli-e2e-gate-hardening.md \
           docs/archived/$(date +%F)-handoff-to-cli-e2e-gate-hardening.md

prepend "**Executed <date> — see PROGRESS.md. Historical.**".

TRACKING: after the merge and the `git pull --ff-only` below, set row 2 of
docs/reviews/handoffs/TRACKING.md to `✅ merged — PR #<n> (<merge sha>), <date>, archived at
docs/archived/<date>-handoff-to-cli-e2e-gate-hardening.md`, fill the PR/merge column, and put the PROGRESS anchor
(your session-log heading and the queue rows you closed) in the Evidence column. Commit that
one edit directly on `main` as `docs(tracking): prompt 2 merged` and push — docs only, no
deploy, the same way `f34800f` recorded Phase 12. This is the last commit of the run — do it
before you report. (The README carries no status; the board does.)

## 10. Ship

Commit in logical chunks (`fix(core): a localStorage that exists is not a localStorage
that works`, `test(e2e): …`, `fix(workspace): adopt the saved version before the
refetch`, `build(infra): …`, `docs(progress): …`). Then:

    git push -u origin fix/e2e-gate-hardening
    gh pr create --base main --head fix/e2e-gate-hardening --title "test: the node-25 guard, prove the page drew, never test stale workers, fix the version_conflict race" --body "<What / Why / Verification with the real numbers / Risk: frontend + settings, no migrations>"

Self-review with three independent passes — *regression* (does `adopt()` change what
authenticated users see anywhere? does the overlay attribute fire on every mode?),
*test-quality* (can the new assertions pass vacuously? run them against a deliberately
broken viewer — e.g. temporarily set `[useInlineScripts]="true"` with the CSP on — and
confirm they FAIL), *infra* (does `test.sh` still work with `--pg`, without `--e2e`, and
on a fresh `reset.sh --yes`?). Fix what is real; re-run the gate on the final commit.

    gh pr merge --merge --delete-branch
    git switch main && git pull --ff-only origin main && git log --oneline -3 && git status

Then the production check from step 8. If production regresses, `git revert` the merge on
`main` and push — do not fix forward. Report: what shipped, gate numbers, the 5× flake
runs, the production smoke result, rows closed, decisions added.
```
