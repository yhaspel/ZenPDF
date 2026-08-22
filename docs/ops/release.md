# Suites and when they run

> **There is no CI.** *(Corrected 2026-08-22 — the "Runs" column below said "every commit" and "every commit to `main`", which describes a pipeline that does not exist: there is no `.github/` and nothing runs a suite automatically. Every gate here is **a person on a machine running `./infra/test.sh`**, and push-to-`main` deploys to Railway **without** running any of it. That is the actual risk model: the gate is a discipline, not an interlock. "Runs" below is now read as *when you are expected to run it*.)*

| Suite | Command | When you run it | Takes |
|---|---|---|---|
| Everything, in one | `./infra/test.sh --e2e` | **before every push to `main`** — it is the gate | ~6 min |
| Backend | `docker compose -f infra/docker-compose.yml run --rm -e DJANGO_SETTINGS_MODULE=config.settings.test api pytest -q` | before every commit that touches `backend/` | ~2 min |
| Frontend unit | `docker compose -f infra/docker-compose.yml run --rm --no-deps web npx ng test --watch=false` | before every commit that touches `frontend/` | ~30 s |
| `@smoke` | `cd e2e && npx playwright test --grep @smoke` | after every deploy, against the deployed host | ~40 s |
| Whole e2e suite | `./infra/test.sh --e2e` (no grep — 63 tests today) | before a release; nightly if you can | ~4 min |
| Cross-browser | `cd e2e && BROWSERS=all npx playwright test` | nightly | ~15 min |
| Query plans | `./infra/test.sh --pg` | before a release | ~10 s |
| Load smoke | `infra/perf/README.md` | before a release, and on the deployed host | ~3 min |

*(The row above was labelled `Full e2e ("@full")`. **There is no `@full` tag** — `@smoke` is the only tag that selects anything. "The full suite" means the suite with no grep, which is what `test.sh` runs.)*

**Two things the gate did not tell you, both closed 2026-08-22** *(`fix/e2e-gate-hardening`; the paragraph here previously listed them as open)*:

- **It exited 0 with dependency-gated tests skipped.** `infra/test.sh` now health-checks Gotenberg from inside the network *before* pytest and fails with "restart gotenberg" rather than turning ten conversion tests into skips nobody reads; and it runs pytest with `-rs` and asserts the skip **set** — four query-plan tests in `apps/core/tests/test_performance.py`, which are vacuous on SQLite and are what `--pg` exists to run — failing with "the gate did not exercise N tests — fix the environment, do not ship" on anything else. Asserting the set and not just the count matters: four Gotenberg skips would have passed a count check.
- **It drove whatever code the Celery workers booted with.** `./infra/test.sh --e2e` now restarts `worker-default`, `worker-heavy`, `worker-render` and `beat`, waits for `/api/health/` to report `checks.workers` true (120 s, then a loud failure), and prints each container's `StartedAt` so the run says out loud what code it tested. `./infra/up.sh` warns — in yellow, without restarting anything, because it is also how you get back to a stack somebody is using — when a worker predates the newest source file under `backend/` (asked of `git ls-files`, so celery beat's own schedule file cannot make the warning fire every time).

## The flake policy

**Zero retries, deliberately.** A test that passes on the second attempt is
telling you something about the product, and a retry count is how that stops
being heard.

When a spec flakes: reproduce it with `--repeat-each=5`, fix the cause, and if
it cannot be fixed the same day, tag it `@quarantine` with a dated comment
saying why. A quarantine older than one phase is a bug nobody owns.

> **`@quarantine` does something now** *(2026-08-22, `fix/e2e-gate-hardening`)*. It was inert for the whole of Phase 10: the config had no `grepInvert` and `infra/test.sh` ran `npx playwright test` bare, so a "quarantined" spec ran with everything else and failed the gate exactly as before — the tag was a comment. `e2e/playwright.config.ts` now sets `grepInvert: /@quarantine/` unless `INCLUDE_QUARANTINE=1`:
>
> ```
> npx playwright test                      # @quarantine excluded — this is the gate
> INCLUDE_QUARANTINE=1 npx playwright test # everything, to see whether it is fixed yet
> ```
>
> Retries stay at **zero**. This is not a retry with a longer name: excluding a spec hides a real failure, so the tag is only ever correct alongside a dated comment and a Human-review-queue row naming what is broken and who owns it. **No spec carries the tag today, and that is the state to keep** — nothing was tagged to make this work.

## Before tagging a release

- [ ] The whole e2e suite green three consecutive runs on the prod-shaped stack. *(Still owed — this is Phase 10's `@full` acceptance criterion, and "three consecutive runs" is a claim only time can make.)*
- [ ] `@smoke` green against the deployed host.
- [ ] `pip-audit` and `npm audit` reviewed — the monthly pass is
      `docs/ops/dependencies.md`.
- [ ] `./infra/test.sh --pg` green (the index assertions are vacuous on the
      hermetic suite's SQLite). It creates a test database from the same
      100-connection budget the running stack is using, so do not run it while
      an e2e suite or a load run is in flight — the symptom is
      `FATAL: sorry, too many clients already`, not a test failure.
- [ ] Anything started under a compose profile is gone: `./infra/down.sh` then
      `docker compose ps -a` empty. A profiled container that survives teardown
      blocks the network removal.
- [ ] `PROGRESS.md` updated, and the launch checklist has no unticked owner item.
