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

**Two things the gate does not tell you, both open** (`docs/reviews/handoffs/handoff-to-cli-e2e-gate-hardening.md` owns them): it exits 0 with dependency-gated tests **skipped** — a Gotenberg container that has drifted turns ten conversion tests into skips and the run still reads green — and it drives whatever code the **Celery workers booted with**, so a long-lived local stack can test stale backend code and produce a false pass.

## The flake policy

**Zero retries, deliberately.** A test that passes on the second attempt is
telling you something about the product, and a retry count is how that stops
being heard.

When a spec flakes: reproduce it with `--repeat-each=5`, fix the cause, and if
it cannot be fixed the same day, tag it `@quarantine` with a dated comment
saying why. A quarantine older than one phase is a bug nobody owns.

> **⚠ `@quarantine` currently does nothing** *(corrected 2026-08-22)*. This said the tag was "excluded from the deploy gate". Nothing excludes it: `e2e/playwright.config.ts` has no `grepInvert`, and `infra/test.sh:106` runs `npx playwright test` bare. **A quarantined test still runs and still fails the gate** — so tagging one today is a comment, not an exclusion, and the honest options are to fix it or to skip it explicitly. Wiring the tag up is `docs/reviews/handoffs/handoff-to-cli-e2e-gate-hardening.md`'s job. (As it happens no spec carries the tag today, so nothing is silently mis-handled — but the next person to reach for it would find it inert.)

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
