#!/usr/bin/env bash
# Run tests: backend pytest + frontend unit; optional Playwright e2e (--e2e).
# 01-architecture.md §18. The e2e suite assumes the stack is already up (up.sh).
#
# Two things this gate is required to be honest about, both learned the hard
# way and both recorded in the PROGRESS Human review queue (2026-08-21):
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
#   2. **It must not test stale backend code.** Celery does not hot-reload, so
#      a stack left up across a backend change runs the old task code while the
#      api container (Django autoreload) runs the new. That is exactly how
#      `phase-2b:130` was misdiagnosed twice in one day — once as a product
#      defect, once as a Playwright quirk — against workers ten days old. A
#      false *pass* is the worse case and would be invisible. `--e2e` therefore
#      restarts the four Celery services and waits for `checks.workers` before
#      driving a browser.
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
echo " Conversion dependency (gotenberg)"
echo "======================================================"
# Fail here, with a cause, rather than ten tests later with a skip nobody reads:
# every `needs_gotenberg` conversion test silently disappears when this
# container has drifted, and the run still exits 0.
if ! docker compose exec -T api curl -sf -o /dev/null http://gotenberg:3000/health; then
  echo "ERROR: gotenberg is not answering /health from inside the network."
  echo "       Ten conversion tests would be skipped and the gate would still"
  echo "       exit 0. Restart gotenberg:"
  echo "         docker compose -f infra/docker-compose.yml restart gotenberg"
  exit 1
fi
echo "gotenberg healthy — the conversion tests will run."

echo "======================================================"
echo " Backend tests (pytest, config.settings.test)"
echo "======================================================"
# The one skip set this gate accepts, asserted by file and not only by count:
# four query-plan assertions that are vacuous on the hermetic suite's SQLite and
# are exercised by `--pg` instead. Anything else skipped is an environment
# fault, and an environment fault is not a green run.
ALLOWED_SKIP_FILE="apps/core/tests/test_performance.py"
ALLOWED_SKIPS=4

count_skips() { grep -c '^SKIPPED' "$1" 2>/dev/null || true; }
foreign_skips() { grep '^SKIPPED' "$1" 2>/dev/null | grep -v "$ALLOWED_SKIP_FILE" || true; }

# Regression test for the guard itself (see the header): the counter is run over
# canned transcripts before it is trusted with a real one.
selftest="$(mktemp -d)"
printf 'SKIPPED [1] apps/core/tests/test_performance.py:49: vacuous on sqlite\nSKIPPED [1] apps/documents/tests/test_convert.py:9: needs gotenberg\n7 passed, 2 skipped\n' > "$selftest/mixed"
printf '1061 passed, 0 skipped\n' > "$selftest/clean"
[ "$(count_skips "$selftest/mixed")" = "2" ] || { echo "skip-guard self-test failed: expected 2 skips"; exit 1; }
[ "$(count_skips "$selftest/clean")" = "0" ] || { echo "skip-guard self-test failed: expected 0 skips"; exit 1; }
[ -n "$(foreign_skips "$selftest/mixed")" ] || { echo "skip-guard self-test failed: a gotenberg skip must be foreign"; exit 1; }
[ -z "$(foreign_skips "$selftest/clean")" ] || { echo "skip-guard self-test failed: a clean run has no foreign skips"; exit 1; }
rm -rf "$selftest"

# Force test settings: the api service's env_file sets dev, and pytest-django's
# env var wins over pyproject — so pass it explicitly for eager Celery + fs storage.
# `-rs` is what makes the skip set readable at all; without it the gate can only
# see a count, and a count cannot tell you what it did not run.
pytest_log="$(mktemp)"
trap 'rm -f "$pytest_log"' EXIT
docker compose run --rm -T -e DJANGO_SETTINGS_MODULE=config.settings.test api pytest -q -rs \
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
docker compose run --rm -T --no-deps web npx ng test --watch=false

if [ "$PG" -eq 1 ]; then
  echo "======================================================"
  echo " Query plans (pytest against Postgres, config.settings.dev)"
  echo "======================================================"
  # The hermetic suite runs on SQLite, where "no Seq Scan" is vacuous. These
  # assertions are the §10.2 index audit, so they need the real planner —
  # `--pg` is what makes them more than documentation.
  docker compose run --rm -T -e DJANGO_SETTINGS_MODULE=config.settings.dev api \
    pytest -q apps/core/tests/test_performance.py
fi

if [ "$E2E" -eq 1 ]; then
  echo "======================================================"
  echo " Restarting the Celery services (never test stale code)"
  echo "======================================================"
  # Celery does not hot-reload. `up.sh` runs `docker compose up -d --build`,
  # which recreates a container only when its image or definition changed, so a
  # stack left up across a backend edit keeps running the old task code — and
  # the e2e suite would be testing it. See the header.
  docker compose restart worker-default worker-heavy worker-render beat
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
  for svc in worker-default worker-heavy worker-render beat; do
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
