#!/usr/bin/env bash
# Run tests: backend pytest + frontend unit; optional Playwright e2e (--e2e).
# 01-architecture.md §18. The e2e suite assumes the stack is already up (up.sh).
set -euo pipefail
cd "$(dirname "$0")"

E2E=0
for arg in "$@"; do
  [ "$arg" = "--e2e" ] && E2E=1
done

echo "======================================================"
echo " Backend tests (pytest, config.settings.test)"
echo "======================================================"
# Force test settings: the api service's env_file sets dev, and pytest-django's
# env var wins over pyproject — so pass it explicitly for eager Celery + fs storage.
docker compose run --rm -T -e DJANGO_SETTINGS_MODULE=config.settings.test api pytest -q

echo "======================================================"
echo " Frontend unit tests (vitest via ng test)"
echo "======================================================"
docker compose run --rm -T --no-deps web npx ng test --watch=false

if [ "$E2E" -eq 1 ]; then
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
