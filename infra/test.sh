#!/usr/bin/env bash
# Run tests: backend pytest + frontend unit; optional Playwright e2e (--e2e).
# 01-architecture.md §18. The e2e suite assumes the stack is already up (up.sh).
#
# What this gate is required to be honest about — each learned the hard way,
# each recorded in the PROGRESS Human review queue. The list is not numbered by
# a count in this sentence, because a count goes stale silently and a list does
# not; it went from two to three on 2026-08-24 and this line would have lied.
#
#   1. **It must not call itself green with tests it never ran.** The
#      2026-08-21 evening run reported "1051 passed, 14 skipped" and was read as
#      green; ten of those skips were the Gotenberg conversion tests, silently
#      not exercised because the local container had drifted. The exit code was
#      0 either way. The skip guard below asserts the skip *set*, not just its
#      size — four Postgres-only query-plan tests and nothing else — and fails
#      loudly on anything more. Gotenberg is health-checked before pytest so
#      that failure arrives with its cause attached.
#
#      The guard's own regression test is the shell self-check right above it:
#      it runs the counter over two canned pytest transcripts before the real
#      run, so a change to the parsing fails here rather than three weeks later
#      by letting ten skips through. It is a shell check and not a pytest,
#      because the thing under test is this file.
#
#   2. **It must not be stopped by a file nobody wrote.** virtiofs duplicates
#      (`fit-width 2.ts`) are gitignored, so `git status` is clean and the only
#      signal is a compiler error naming a *generated sibling* of the stray.
#      Checked first, because one is enough to fail every leg after it.
#
#   3. **It must not test stale backend code.** Celery does not hot-reload, so
#      a stack left up across a backend change runs the old task code while the
#      api container (Django autoreload) runs the new. That is exactly how
#      `phase-2b:130` was misdiagnosed twice in one day — once as a product
#      defect, once as a Playwright quirk — against workers ten days old. A
#      false *pass* is the worse case and would be invisible. `--e2e` therefore
#      restarts the four Celery services **and `api`** and waits for
#      `checks.workers` before driving a browser. `api` is there for a second
#      reason — it holds the Postgres pool; see the restart itself.
set -euo pipefail
cd "$(dirname "$0")"

E2E=0
PG=0
for arg in "$@"; do
  [ "$arg" = "--e2e" ] && E2E=1
  [ "$arg" = "--pg" ] && PG=1
done

env_val() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2; }
API_PORT="$(env_val API_PORT)"; API_PORT="${API_PORT:-8000}"

echo "======================================================"
echo " Stray virtiofs duplicates"
echo "======================================================"
# macOS + Docker Desktop's virtiofs mount occasionally leaves a copy of a file
# beside it — `fit-width 2.ts`, `tsconfig.app 2.json`, `helpers 3.ts`. Nobody
# writes them and nothing imports them, but the TypeScript program includes
# every file under `src`, so one is enough to stop a build that has nothing
# wrong with it.
#
# The reason this is a gate check and not a lint rule is that **`git status`
# cannot see them**: `.gitignore` has disowned the shape since `1e1919a`, which
# keeps them out of commits and equally out of every "is my tree clean?" answer.
# So the first and only signal was the compiler, and it does not name the real
# problem. Measured 2026-08-24, the third recorded occurrence: a build that had
# just succeeded printed `Prerendered 0 static routes.` and then
# `TS6053: File '/app/src/app/shared/fit-width 2.ngtypecheck.ts' not found` —
# an error about a file nobody wrote, referring to a *generated* sibling of a
# stray, two indirections from the truth. It cost a full gate run.
#
# Fails rather than deleting. The pattern is a heuristic — `report 2.md` is a
# perfectly ordinary name — and a gate that quietly removes files it guessed
# about is worse than one that stops and shows its working. `up.sh` takes the
# same line with stale workers, for the same reason.
STRAY_PRUNE=( -name node_modules -o -name .angular -o -name dist -o -name test-results -o -name .venv -o -name __pycache__ )
# Two shapes, because virtiofs makes both, and they need different scopes.
#
#   * `foo 2.ts` — has an extension. Scanned across all three trees, as before.
#   * `wasm 2`, `zenpdf-web 3` — *directories*, no extension. Scanned only
#     under the three source roots a compiler actually reads, because a
#     tree-wide extensionless match is unusable: `backend/` alone holds
#     sixteen `celerybeat-schedule-wal 2`-shaped runtime artefacts, and a
#     guard that cries every run is a guard somebody deletes.
#
# The extensionless shape is the one that breaks a *build* rather than a
# compile, which is why it went unnoticed until 2026-08-25 — see the `dist`
# clean below, which handles the one place neither scan can look.
strays="$(
  find ../frontend ../e2e ../backend \( "${STRAY_PRUNE[@]}" \) -prune -o \
    -name '* [0-9].*' -print 2>/dev/null || true
  find ../frontend/src ../e2e/tests ../backend/apps \( "${STRAY_PRUNE[@]}" \) -prune -o \
    -name '* [0-9]' -print 2>/dev/null || true
)"
if [ -n "$strays" ]; then
  echo "ERROR: virtiofs left duplicate files in the tree. They are gitignored, so"
  echo "       'git status' is clean and the only other signal is a compiler error"
  echo "       naming a file nobody wrote."
  echo
  printf '%s\n' "$strays" | sed 's|^\.\./|  |'
  echo
  echo "       Check they are the artefact and not something you meant to keep,"
  echo "       then from the repo root:"
  echo "         find frontend e2e backend \\( -name node_modules -o -name .angular \\"
  echo "           -o -name dist -o -name test-results \\) -prune -o -name '* [0-9].*' -print -delete"
  exit 1
fi
echo "None."

echo "======================================================"
echo " Infra consistency (SSRF layer-2 deny-list copies)"
echo "======================================================"
# The Gotenberg deny-list literal is written out four times — settings default,
# both compose files, and .env.example — because `${VAR}` with no fallback would
# pass an *empty* deny-list on a machine whose .env predates the setting, which
# turns layer 2 of the SSRF guard off silently (§17). Four copies is four
# chances to update three of them, and the hermetic pytest suite cannot see this
# directory (the api container mounts backend/ and nothing else), so the drift
# check lives here. `$$` is an escaped `$`.
python3 - <<'PY'
import pathlib, sys

marker = "--chromium-deny-list=${GOTENBERG_DENY_LIST:-"
copies = {}
for name in ("docker-compose.yml", "docker-compose.prod.yml"):
    text = pathlib.Path(name).read_text()
    assert marker in text, f"{name} no longer passes a deny-list to Gotenberg"
    copies[name] = text.split(marker, 1)[1].split("}\n", 1)[0]
for line in pathlib.Path(".env.example").read_text().splitlines():
    if line.startswith("GOTENBERG_DENY_LIST="):
        copies[".env.example"] = line.split("=", 1)[1]

normalized = {k: v.replace("$$", "$") for k, v in copies.items()}
if len(set(normalized.values())) != 1:
    for name, value in sorted(normalized.items()):
        print(f"  {name}: {value}", file=sys.stderr)
    sys.exit("SSRF deny-list copies have drifted from each other")
if "," in next(iter(normalized.values())):
    sys.exit("deny-list contains a comma; gotenberg's flag parser splits on it")
print(f"deny-list identical across {len(copies)} infra copies")
PY

echo "======================================================"
echo " Backend lint + types (ruff, mypy)"
echo "======================================================"
# mypy reached zero in phase 10 and the gate is what keeps it there. It got to
# 98 findings in the first place by being run by nobody.
docker compose run --rm -T api sh -c "ruff check . && mypy apps config"

echo "======================================================"
echo " Backend correctness checks (django, migrations, OpenAPI)"
echo "======================================================"
# All three are named in the Definition of Done (§20) and in every handoff's
# gate section, and until 2026-08-23 this script ran none of them — so each was
# something a person had to remember, which means each was something a person
# could report without having run. That is not a hypothetical: the backend-debt
# session log claimed `manage.py check` and `build + verify:prerender` and had
# run neither. They passed when finally run, which is luck, not a gate.
#
# `makemigrations --check` catches a model edited without its migration, which
# is the failure that only shows up on somebody else's fresh database.
docker compose run --rm -T -e DJANGO_SETTINGS_MODULE=config.settings.test api sh -c "
  python manage.py check &&
  python manage.py makemigrations --check --dry-run &&
  python manage.py spectacular --fail-on-warn > /dev/null && echo 'OpenAPI schema: 0 warnings'"

echo "======================================================"
echo " Conversion dependency (gotenberg)"
echo "======================================================"
# Fail here, with a cause, rather than ten tests later with a skip nobody reads:
# every `needs_gotenberg` conversion test silently disappears when this
# container has drifted, and the run still exits 0.
# urllib rather than curl: the api image does not ship curl, and adding it to a
# production image to run a health check would be the wrong trade. Python is
# what that container is for.
#
# `run --rm` rather than `exec`, so this works whether or not the long-running
# api container happens to be up — every other step here uses `run` too, and a
# gate that needs the stack already running would fail with the wrong message.
if ! docker compose run --rm -T api python -c "
import sys, urllib.request
try:
    with urllib.request.urlopen('http://gotenberg:3000/health', timeout=5) as r:
        sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
"; then
  echo "ERROR: gotenberg is not answering /health from inside the network."
  echo "       Ten conversion tests would be skipped and the gate would still"
  echo "       exit 0. Bring the stack up (./infra/up.sh), or restart gotenberg:"
  echo "         docker compose -f infra/docker-compose.yml restart gotenberg"
  exit 1
fi
echo "gotenberg healthy — the conversion tests will run."

echo "======================================================"
echo " Backend tests (pytest, config.settings.test)"
echo "======================================================"
# The one skip set this gate accepts, asserted by file and not only by count:
# assertions whose *subject* does not exist on the hermetic suite's SQLite —
# four query plans, and two that stage the concurrency-slot race across two
# connections. Both files carry `@PG_ONLY`, and `--pg` below runs exactly them.
# Anything else skipped is an environment fault, and an environment fault is not
# a green run.
#
# Kept as a regex over paths rather than a count, because a count cannot tell
# you what it did not run — which is the failure this guard exists for.
ALLOWED_SKIP_FILES="apps/core/tests/test_performance.py|apps/core/tests/test_concurrency_pg.py"
ALLOWED_SKIPS=6

count_skips() { grep -c '^SKIPPED' "$1" 2>/dev/null || true; }
foreign_skips() { grep '^SKIPPED' "$1" 2>/dev/null | grep -Ev "$ALLOWED_SKIP_FILES" || true; }

# Regression test for the guard itself (see the header): the counter is run over
# canned transcripts before it is trusted with a real one.
selftest="$(mktemp -d)"
printf 'SKIPPED [1] apps/core/tests/test_performance.py:49: vacuous on sqlite\nSKIPPED [1] apps/documents/tests/test_convert.py:9: needs gotenberg\n7 passed, 2 skipped\n' > "$selftest/mixed"
printf '1061 passed, 0 skipped\n' > "$selftest/clean"
# Both allowed files, so widening the set to two paths is itself checked here
# rather than only by the run that follows.
printf 'SKIPPED [1] apps/core/tests/test_performance.py:49: vacuous on sqlite\nSKIPPED [1] apps/core/tests/test_concurrency_pg.py:120: no row locks on sqlite\n2 skipped\n' > "$selftest/allowed"
[ "$(count_skips "$selftest/mixed")" = "2" ] || { echo "skip-guard self-test failed: expected 2 skips"; exit 1; }
[ "$(count_skips "$selftest/clean")" = "0" ] || { echo "skip-guard self-test failed: expected 0 skips"; exit 1; }
[ -n "$(foreign_skips "$selftest/mixed")" ] || { echo "skip-guard self-test failed: a gotenberg skip must be foreign"; exit 1; }
[ -z "$(foreign_skips "$selftest/clean")" ] || { echo "skip-guard self-test failed: a clean run has no foreign skips"; exit 1; }
[ -z "$(foreign_skips "$selftest/allowed")" ] || { echo "skip-guard self-test failed: both PG-only files must be allowed"; exit 1; }
rm -rf "$selftest"

# Force test settings: the api service's env_file sets dev, and pytest-django's
# env var wins over pyproject — so pass it explicitly for eager Celery + fs storage.
# `-rs` is what makes the skip set readable at all; without it the gate can only
# see a count, and a count cannot tell you what it did not run.
#
# Run under coverage, because §18 states "Coverage gate: apps 85%, pdf_engine
# 90%" and §20's Definition of Done item 3 says the gates hold — and until
# 2026-08-23 nothing measured them. Not `fail_under`: that is a single global
# number, and the two thresholds are different and per-package. The assertion
# is below, next to the skip guard, for the same reason as the skip guard.
#
# COVERAGE_FILE points inside the container so no `.coverage` lands in the repo.
pytest_log="$(mktemp)"
trap 'rm -f "$pytest_log"' EXIT
docker compose run --rm -T -e DJANGO_SETTINGS_MODULE=config.settings.test \
  -e COVERAGE_FILE=/tmp/.coverage.gate api sh -c "
    pytest -q -rs --cov=apps --cov-report= &&
    echo '--- coverage ---' &&
    printf 'APPS_PCT=' && coverage report --format=total --precision=2 &&
    printf 'ENGINE_PCT=' && coverage report --format=total --precision=2 --include='apps/pdf_engine/*'" \
  | tee "$pytest_log"

skipped="$(count_skips "$pytest_log")"
unexpected="$(foreign_skips "$pytest_log")"
if [ -n "$unexpected" ] || [ "$skipped" -gt "$ALLOWED_SKIPS" ]; then
  echo
  echo "ERROR: the gate did not exercise ${skipped} tests — fix the environment, do not ship."
  echo "       Expected at most ${ALLOWED_SKIPS} skips, all in ${ALLOWED_SKIP_FILE}."
  echo "       Skipped:"
  grep '^SKIPPED' "$pytest_log" | sed 's/^/         /'
  exit 1
fi
if [ "$PG" -eq 1 ]; then
  echo "${skipped} skipped, all query plans — exercised against Postgres below."
else
  echo "${skipped} skipped, all query plans — pass --pg to exercise them."
fi

# The coverage gate §18 states and §20 requires. Asserted here rather than by
# `fail_under` because the two floors differ per package, and read out of the
# run above rather than measured again — a second pass would be two minutes to
# re-learn a number we already have.
APPS_FLOOR=85
ENGINE_FLOOR=90
# `|| true` is what makes the guard below reachable at all. Without it, `set -e`
# plus `pipefail` abort the script *on the assignment* when grep matches nothing
# — so the five lines of explanation underneath could never be printed, and a
# missing coverage number would surface as a bare `exit 1` with no cause
# attached. That is the exact failure this script exists to prevent, committed
# inside the check written to prevent it. Found by an adversarial review of this
# very commit and reproduced before fixing.
apps_pct="$(grep -oE '^APPS_PCT=[0-9.]+' "$pytest_log" | head -1 | cut -d= -f2 || true)"
engine_pct="$(grep -oE '^ENGINE_PCT=[0-9.]+' "$pytest_log" | head -1 | cut -d= -f2 || true)"
if [ -z "$apps_pct" ] || [ -z "$engine_pct" ]; then
  echo "ERROR: coverage did not report a number. The gate must not pass a coverage"
  echo "       check it could not perform — that is the whole lesson of the skip set."
  exit 1
fi
# Two decimal places, compared with awk rather than with `[ -ge ]`, because the
# integer form ROUNDS: 89.6% renders as "90" and would clear a 90% floor it is
# actually under. A gate that rounds up into passing is the false pass this
# script exists to make impossible.
below() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'; }
cov_failed=0
below "$apps_pct" "$APPS_FLOOR" && { echo "ERROR: apps coverage ${apps_pct}% is below the ${APPS_FLOOR}% gate (§18)."; cov_failed=1; }
below "$engine_pct" "$ENGINE_FLOOR" && { echo "ERROR: pdf_engine coverage ${engine_pct}% is below the ${ENGINE_FLOOR}% gate (§18)."; cov_failed=1; }
[ "$cov_failed" -eq 0 ] || exit 1
echo "coverage: apps ${apps_pct}% (gate ${APPS_FLOOR}), pdf_engine ${engine_pct}% (gate ${ENGINE_FLOOR}) — both hold."

echo "======================================================"
echo " Frontend lint (eslint via ng lint)"
echo "======================================================"
# A static template linter reaches every branch; axe can only see rendered DOM.
# That difference is why this found twelve unlabelled controls behind panel tabs
# the phase-10 a11y sweep never opened.
docker compose run --rm -T --no-deps web npx ng lint

echo "======================================================"
echo " Frontend unit tests (vitest via ng test)"
echo "======================================================"
# The long-running dev server is stopped first, and this is not tidiness.
#
# The unit leg runs in its *own* `--no-deps` container and never talks to the
# dev server — but they compete for the same Docker VM, and vitest loses. The
# symptom is the worst kind: N unrelated spec files failing one test each with
# `Hook timed out in 10000ms`, which reads exactly like the change under test
# breaking things. It has now been recorded five times on five different
# branches, twice on branches that changed **zero** frontend files, and the
# failing set is different every run.
#
# Measured here on 2026-08-23, same commit, back to back:
#   dev server up   → 2 failed / 464 passed, 25.3 s (transform 98.9 s, import 151.0 s)
#   dev server down → 0 failed / 466 passed,  5.3 s (transform  6.3 s, import  11.1 s)
#
# `test.sh` already brings `web` back up before the e2e leg, for a related
# reason it had also learned the hard way, so this costs nothing downstream.
# A red gate that does not mean anything is the same failure the skip-set guard
# above exists to prevent.
docker compose stop web >/dev/null 2>&1 || true
docker compose run --rm -T --no-deps web npx ng test --watch=false

echo "======================================================"
echo " Production build + prerender (SSR is build-time)"
echo "======================================================"
# §9 asks for "build + verify:prerender" and this script ran neither, so the
# only thing standing between a broken prerender and a release was somebody
# remembering. SSR here is build-time (`outputMode: static`, see AGENTS.md), so
# a prerender that silently stops emitting routes is a silent SEO outage — the
# same shape as the viewer that rendered nothing in production for ten days
# while every check stayed green.
#
# Runs while `web` is still stopped, deliberately: this is a full production
# build and it loses the same race the vitest step does.
# `dist` is deliberately pruned by the stray guard above — build output is
# regenerable, so failing the gate on a stray inside it would be noise. But
# `ng build` *cleans* that directory before writing, and `rmdir` fails on a
# stray directory inside it: measured 2026-08-25, a gate that had already
# passed ruff, mypy, 1164 pytest and 576 unit tests died six minutes in on
# `ENOTEMPTY: directory not empty, rmdir '/app/dist/…/assets/wasm 2'`, with
# eleven strays under `frontend/dist`. Clearing it here is free — the build
# rewrites it entirely — and it closes the one place the guard cannot look.
rm -rf ../frontend/dist
docker compose run --rm -T --no-deps web npm run build
docker compose run --rm -T --no-deps web npm run verify:prerender

# …and put `web` back, whether or not `--e2e` follows. A gate that leaves the
# developer's dev server stopped has fixed one surprise by introducing another;
# the e2e leg's own `up -d web` then just waits for a container already coming
# up. `set -e` is active, so this runs only on a green run — which is what we
# want: a red one leaves the stack exactly as it was for inspection.
docker compose up -d web >/dev/null 2>&1 || true

if [ "$PG" -eq 1 ]; then
  echo "======================================================"
  echo " Postgres-only tests (-m pg_only, config.settings.dev)"
  echo "======================================================"
  # Everything whose *subject* does not exist on SQLite:
  #
  #   * query plans — "no Seq Scan" is vacuous without the real planner. These
  #     are the §10.2 index audit, and `--pg` is what makes them more than
  #     documentation.
  #   * the concurrency slot — `_concurrency_slot` takes `SELECT … FOR UPDATE`
  #     only where `has_select_for_update` is True, which SQLite is not. The
  #     hermetic suite therefore exercised the *path* and not the *lock*, and
  #     could not have failed if the lock were deleted. `test_concurrency_pg.py`
  #     stages the race across two connections, twenty times.
  #
  # Selected by marker rather than by filename: this flag used to name one file,
  # so a second Postgres-only file would have been written and then never run.
  docker compose run --rm -T -e DJANGO_SETTINGS_MODULE=config.settings.dev api \
    pytest -q -rs -m pg_only
fi

if [ "$E2E" -eq 1 ]; then
  echo "======================================================"
  echo " Restarting the Django + Celery services"
  echo "======================================================"
  # Celery does not hot-reload. `up.sh` runs `docker compose up -d --build`,
  # which recreates a container only when its image or definition changed, so a
  # stack left up across a backend edit keeps running the old task code — and
  # the e2e suite would be testing it. See the header.
  #
  # `api` is in this list for a different reason: it holds the Postgres pool.
  # `conn_max_age=600` against the container's `max_connections=100` means a
  # dev server that has been up all day accumulates one connection per request
  # thread and never gives them back. Fourth measurement, 2026-08-24: **99 idle
  # connections from `api` alone, the oldest 5 h 57 m**, and five specs red at
  # `registerAndLogin` and at the first save — which reads like a product
  # regression and is a laptop. The health gate below cannot catch it on its
  # own, because the budget is fine *before* the run and exhausted *during* it.
  # Restarting `api` costs one autoreload and starts every run from ~10.
  docker compose restart api worker-default worker-heavy worker-render beat
  # `checks.workers` **and** the overall verdict. Asking only about the workers
  # was not enough: a stack whose Postgres has run out of connections reports
  # `{"status":"degraded","checks":{"db":false,...,"workers":true}}`, and the
  # suite then fails at `registerAndLogin` in a dozen specs at once — which
  # reads like a product regression and is a laptop that has been running e2e
  # all afternoon (`conn_max_age=600` against a 100-connection budget). Measured
  # here on 2026-08-22: 7 of 11 specs red, zero failed jobs, `db:false`.
  echo "Waiting for the stack to report healthy (workers included)..."
  health_ready=0
  for _ in $(seq 1 60); do
    health="$(curl -s "http://localhost:${API_PORT}/api/health/" 2>/dev/null || true)"
    case "$health" in
      *'"status":"ok"'*) case "$health" in *'"workers":true'*) health_ready=1;; esac;;
    esac
    [ "$health_ready" -eq 1 ] && break
    sleep 2
  done
  if [ "$health_ready" -ne 1 ]; then
    echo "ERROR: /api/health/ did not report ok within 120 s. Refusing to run the"
    echo "       e2e suite against a stack that already knows it is broken —"
    echo "       every spec would fail for a reason that is not the product."
    echo "       Last health: ${health:-<none>}"
    echo "       Check: ./logs.sh api  ·  ./logs.sh db  ·  ./logs.sh worker-default"
    exit 1
  fi
  for svc in api worker-default worker-heavy worker-render beat; do
    cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
    [ -n "$cid" ] && printf '  %-15s started %s\n' "$svc" \
      "$(docker inspect -f '{{.State.StartedAt}}' "$cid")"
  done

  echo "======================================================"
  echo " E2E tests (Playwright against the running stack)"
  echo "======================================================"
  WEB_PORT="$(grep -E '^WEB_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2)"; WEB_PORT="${WEB_PORT:-4200}"
  # The frontend-unit step can transiently OOM the web server; ensure it is back
  # up and serving before driving the browser.
  docker compose up -d web >/dev/null 2>&1 || true
  echo "Waiting for web (http://localhost:${WEB_PORT}) to be ready..."
  ready=0
  for _ in $(seq 1 40); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT}/" 2>/dev/null)" = "200" ]; then
      ready=1; break
    fi
    sleep 3
  done
  [ "$ready" -eq 1 ] || { echo "ERROR: web did not become ready"; exit 1; }
  (
    cd ../e2e
    npm install
    npx playwright install chromium
    npx playwright test
  )
fi

echo "All requested test suites passed."
