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
docker compose run --rm -T api pytest -q

echo "======================================================"
echo " Frontend unit tests (vitest via ng test)"
echo "======================================================"
docker compose run --rm -T --no-deps web npx ng test --watch=false

if [ "$E2E" -eq 1 ]; then
  echo "======================================================"
  echo " E2E tests (Playwright against the running stack)"
  echo "======================================================"
  (
    cd ../e2e
    npm install
    npx playwright install chromium
    npx playwright test
  )
fi

echo "All requested test suites passed."
