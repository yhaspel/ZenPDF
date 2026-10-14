**Executed 2026-10-14. See PROGRESS.md session log "2026-10-14 — Test-gap sweep: 778 tests, zero product source", PR #51 (`18e1b9f`), TRACKING row 14. The patch's sha256 matched (`3a951fa3…78d32`), and `git am -3` applied it clean on `80772f0` as `27e8a56`, which shipped unchanged underneath eight test-only self-review commits. The scope grep printed nothing over the whole branch. **Step 0 could not be followed as written.** There is no nvm on this Mac (node 22.23.3 from `node@22` was used). The repo sits in iCloud-synced `~/Documents` on a 96 %-full disk, so files were evicted: the `web` build crawled, because its dev target `COPY . .`s a `frontend/` with no `.dockerignore`, and the dev server died on `EIO`. The seven tracked files the gate reads were read back on the host, and `up.sh` was finished by hand with `--no-build`. **Step 2 did not go green first time, and the gate was right to stop.** The unit leg failed 4, then 3, specs with timeouts, a different set each time, on a host at load 27–44. Paired controls (`main` green twice; then, quiet, the branch 1 049 / 1 049 three times) traced it to the machine. A bisection that seemed to blame one spec was refuted by repetition. No budget was raised. **Final gate on `af8ac63`:** backend 1 665 passed / 6 skipped, coverage 97.03 % / 96.23 %; unit 1 050 / 105 files; lint clean; 43 prerendered routes; `--pg` 6; Playwright 96 passed / 1 skipped. **Step 4 found more than step 4 asked for.** An eight-reviewer adversarial pass, each finding put to a skeptic, returned 46 findings (41 confirmed). 44 were fixed, every strengthened test shown to fail under a one-line product mutation, and 15 defect pins were rewritten to assert what a correct fix keeps. The three random honesty picks all went red under mutation. The unit leg ran twice and the backend shuffled (seed 20261014), all green. **The fixes exposed 18 product defects, each independently reproduced.** Four are addenda to the seven rows. Six are new queue rows, one of them **high**: sanitize's *Hidden layers* reveals an annotation on a switched-off layer, and reports nothing removed. One more row came from production (below). **Step 6:** all six services deployed `18e1b9f`; health ok; `@smoke` 5 passed / 2 environmental, both classified standalone (`smoke-viewer` drew 1056×1494 in 3.6 s; `phase-8:135` stopped at its Mailpit poll); `pwa-check` exit 0; landing clean in both themes at 1280 and 390. **Corrections this prompt owes:** The sweep added **405** backend tests, not 407 (the sandbox's figure was a passed-count delta). That makes **776** tests as delivered (779 after the self-review), not 778; pdf_engine coverage is **96.23 %**, not ≈ 99 %: the figure covers modules the sweep never touched; Three frontend modules have no spec, not one: `app.config.ts`, `app.config.server.ts` and `app.routes.server.ts`; Row 3's account is any *full* account, not specifically a paying one: the note's repro uses the free tier; "Hard to reach through the UI" for defect 5 misses one keyboard route, Ctrl/Cmd+X in the Forms builder, though it is harmless today; **"The main bundle hash has changed" was the wrong expectation.** `main-EN7G747P.js` is unchanged, because a content-hashed build of unchanged source is identical, and a local build of `main` reproduces it. The rebuild is proven by `ngsw.json`'s build timestamp, 2026-09-26 09:31 → 2026-10-14 05:11 UTC; **"Byte-identical in behaviour" holds, but byte-identical does not.** The stylesheet gained exactly one rule, `.sepia`, because Tailwind v4 scans spec files and `theme.service.spec.ts:135` contains the word. That is a queue row (low). The delivery pair (`.zen-test-gap-sweep.patch`, `.zen-test-gap-sweep-HANDOFF.md`) was removed as step 7 says, after confirming this file is the pre-apply copy plus this banner. Historical.**

# Test-gap sweep — CLI handoff (one-shot prompt)

Paste this whole file into `claude` in the repo root on the Mac
(`~/Documents/Claude/Projects/ZenPDF`). It lands one patch — **55 new test files and one
findings note, zero product source** — through the repo's own gate, PR, merge and the
Railway deploy that a push to `main` is, and proves production is unchanged afterwards.

Delivery pair in the repo root (untracked): `.zen-test-gap-sweep.patch` and this file.
Patch sha256: `3a951fa3eeaa319cd14702abf9ce6d6e374f2ccb950bee01c33df251f2478d32`.
Verify with `shasum -a 256 .zen-test-gap-sweep.patch` before applying.

## What this is

A 2026-10-13/14 sweep over the measured unit/integration gaps, done in a cloud sandbox on
`main @ 80772f0` (the "ZenPDF is installable" commit). Baseline there: backend **1 241
passed / 92 % line coverage**, frontend **678 specs / 69 files**. The sweep adds **407
backend tests** (`apps` → **97 %**, 47 modules at 100 %, every `pdf_engine/engine/*`
module it touched at 100 %) and **371 frontend specs** (every module that no spec imported
now has one — the signer ceremony, settings, dashboard, landing, app-shell, the legal
pages, `client-errors`, folders, the unsaved-work guard, the signature pad, theme service
with boot-script parity, toasts, confirm, modal, banners, dropzone, and the small shared
components). The record is the committed note
`docs/reviews/2026-10-14-test-gap-sweep.md` — numbers, per-module deltas, what stayed
uncovered and why.

**Seven product defects were found and independently reproduced — none is fixed in this
patch, by design.** They are described with repros in the note's last section and become
Human review queue rows in step 3. In one line each:

1. `pages.py:287` — `merge()` propagates a bare `RecursionError` on a deep outline.
2. `esign/views.py:341-343` — PATCH slices `title[:5000]` against a 255-char column.
3. `esign/views.py:123` — saving a signature at storage quota is a 500 (`AssetQuotaExceeded` uncaught).
4. `folders.facade.ts:14,18` — every HTTP error swallowed; a failed folder create looks like success.
5. `confirm.service.ts:15-18` — a second `ask()` orphans the first caller's promise.
6. `upload-dropzone.ts:28-36` — not keyboard-operable, and it is the only route into the picker (WCAG 2.1.1).
7. `modal.directive.ts:39` — focus-trap anchors never attach when `zenModal` is an `@if` root (Tool options, Add link).

## What the patch is

One commit, `test: close the measured unit/integration gaps …`, **56 files, 10 433
insertions, 0 deletions.** `git show --stat` must agree. Every path matches
`\.spec\.ts$`, `/tests/test_.*\.py$` or `^docs/reviews/`; nothing else. No dependency,
config, migration, `package.json`, `requirements/*`, `pyproject.toml`, `angular.json` or
`vitest.config.ts` change. Because the new files sit under `backend/**` and `frontend/**`,
Railway's watch patterns will rebuild all six app services on merge — the images will be
byte-identical in behaviour (specs are excluded from the Angular build; pytest files ride
along in the api image as they always have) but a deploy *will* happen, which is why step 6
exists.

## Already verified in the sandbox (do not re-derive, do re-run)

- Backend, full `pytest` with coverage: **1 648 passed / 16 skipped / 5 failed**, the five
  being the identical set `main` fails in that sandbox — PDF/A (no Ghostscript) and three
  OCR tests (no `unpaper`, no `heb` pack). They pass in the worker image. `ruff check .`
  clean; `mypy apps config` clean (199 files).
- Frontend: **1 049 passed / 105 files**, run three times (vitest reorders files between
  runs); `ng lint` clean.
- An independent reviewer that had not seen the tests written sampled fourteen files and
  ran **ten product mutations** (a clamp removed, a branch flipped, a constant changed,
  each reverted) — **all ten were caught** by at least one new test. It also removed the
  one assertion that had pinned defect 5 as a contract.
- What the sandbox could not do: the compose stack (Gotenberg, Mailpit, Postgres), the
  five binary-dependent tests above, `--pg`, `--e2e`, and anything on production.

## Your job

0. **Preflight.** `git status` — a clean tree on `main` at or after `80772f0`, plus the
   untracked delivery pair. `git switch main && git pull --ff-only`. `nvm use 24` for
   anything you run on the host (the Mac's node 25 is the README's standing warning; the
   gate runs the frontend legs in the container anyway). `./infra/up.sh`, then
   `docker compose -f infra/docker-compose.yml restart api worker-default worker-heavy worker-render beat`
   — Celery does not hot-reload and the gate asserts the skip *set*, so a stale worker is
   a red gate with the wrong message.
1. **Apply.** `git switch -c test-gap-sweep && git am -3 .zen-test-gap-sweep.patch`.
   If `main` has moved since `80772f0`, `-3` resolves it (every file is new; a conflict
   can only mean a spec or test file with the same path now exists — stop and say so
   rather than overwrite). Then prove the scope claim:
   `git diff --name-only HEAD~1 HEAD | grep -vE '\.spec\.ts$|/tests/test_[^/]+\.py$|^docs/reviews/'`
   must print nothing. Set the TRACKING row (the next free number) 🔵 in a follow-up
   docs commit.
2. **Gate.** The full `./infra/test.sh --pg --e2e`. Expected shape, and what to do
   when it differs:
   - backend **≥ 1 648 passed**, skips exactly the allowed six (`--pg` then runs them);
     coverage line reads apps ≈ **97 %**, pdf_engine ≈ **99 %** (gate floors 85 / 90).
     The five sandbox failures must be green here — if any is red, it is red on `main`
     too (check before blaming the patch).
   - unit **1 049 passed / 105 files**. The suite grew by 36 files; the per-worker
     jsdom warm-up `vitest.config.ts` describes lands on whichever file runs first. If a
     spec the patch never touched fails only with `Test timed out in 15000ms`, re-run the
     unit leg once and record both results in the session log. **Do not raise the budget.**
   - `ng lint` clean, build + `verify:prerender` unchanged (43 routes as of PR #49),
     e2e unchanged — the patch touches no product code, so any e2e difference from the
     last green run on `main` is environmental; say which and why.
   - `test_observability.py` needs `ADMIN_ENABLED=true` and a reachable Redis; the
     compose env supplies both. Outside Docker it fails two tests and that is not news.
3. **Record.** In `development-plans/PROGRESS.md`: a session-log entry **"2026-10-14 —
   Test-gap sweep: 778 tests, zero product source"** with the gate's real numbers, and
   **seven Human review queue rows**, one per defect, dated 2026-10-14, each carrying the
   file:line, the one-line repro and the severity from
   `docs/reviews/2026-10-14-test-gap-sweep.md` (copy, don't paraphrase; the note is the
   source). Rows 3 and 6 deserve the owner's attention first — a paying account that
   cannot save a signature, and a WCAG 2.1.1 failure on the product's primary action.
   None is GATE. Do **not** fix any of them in this PR: a test sweep that quietly patches
   the product is two changes pretending to be one, and each fix wants its own test that
   fails on `main`.
4. **Self-review before the PR.** Adversarial pass over the diff with lenses that
   matter for a test-only change: (a) scope — the grep in step 1 is the contract;
   (b) determinism — run the unit leg twice and the backend suite once with
   `-p no:randomly` removed if you have it installed, no order dependence (`conftest.py`
   already clears the cache between tests); (c) honesty — pick three new tests at random,
   break the product line each targets, watch it fail, revert; (d) nothing that pins a
   defect as a contract (the reviewer removed one; make sure none remains — grep the new
   specs for "never settled", "current behaviour", "pins"); (e) no `@pytest.mark.skip`,
   `xfail`, `it.skip` or `it.only` in the patch. Fix what is real, in follow-up commits.
5. **Ship.** `gh pr create` from `test-gap-sweep` → `main` with the note's "Numbers"
   table in the body and the seven defects listed; merge the way the previous PRs were
   merged (squash per habit), then `git switch main && git pull --ff-only`. Then the
   `docs(tracking): …` commit directly on `main`: TRACKING row ✅ with PR + merge sha,
   this prompt archived to `docs/archived/2026-10-14-handoff-to-cli-test-gap-sweep.md`
   with an **Executed** banner in the house style (the model is
   `docs/archived/2026-09-25-handoff-to-cli-annotate-text-wysiwyg.md`), and the PROGRESS
   anchor in the row.
6. **Verify production.** The merge rebuilds `web`, `api`, the three workers and `beat`.
   Wait for all six to show the merge sha deployed (Railway dashboard, or
   `railway status`). Then, in this order:
   - `curl -s https://zenpdf.up.railway.app/api/health/ | jq` → `status: ok`, every check
     `true` including `workers`.
   - from `e2e/`: `BASE_URL=https://zenpdf.up.railway.app npx playwright test --grep @smoke`
     — the deploy gate `playwright.config.ts` names; expect the same count as the last
     production run.
   - from `e2e/`: `node tools/pwa-check.mjs https://zenpdf.up.railway.app` — active `sw`,
     `manifestErrors: []`, `installabilityErrors: []`, exit 0 (the previous commit's
     own check; a test-only merge must not move it).
   - the main bundle hash in `view-source:` has changed (the `web` image rebuilt) and the
     landing page renders in both themes at 1280 and 390 px with a clean console.
   Record each result in the session log. If health degrades or `@smoke` goes red,
   redeploy the previous deployment of the affected service from the Railway dashboard
   and stop — a test-only change that breaks production is a build-pipeline problem,
   not something to debug live.
7. **Leave the tree clean.** No `.zen-test-gap-sweep.patch`, no
   `.zen-test-gap-sweep-HANDOFF.md`, TRACKING row ✅, prompt archived, PROGRESS updated.

## Out of scope — do not widen

- The seven defects. Queue rows only; each is its own prompt.
- The `docs/reviews/handoffs/README.md` baseline line (frozen at `f34800f` by design).
- Any product, dependency, config or infra change. If the gate can only go green by
  changing one, stop and report; the patch is wrong, not the gate.

## Warnings inherited

- Never run git through the Cowork device bridge. `_to_delete/` and `Claude outputs/`
  are the owner's; leave them alone.
- The gate's skip guard and coverage floors are assertions, not advice. A red gate
  with a cause you understand is a finding; a green gate you edited into being is not.
