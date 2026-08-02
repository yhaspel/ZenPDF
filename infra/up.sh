#!/usr/bin/env bash
# Bring up the full ZenPDF dev stack, idempotently (01-architecture.md §5).
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Checking Docker..."
docker info >/dev/null 2>&1 || { echo "ERROR: Docker daemon is not running."; exit 1; }

if [ ! -f .env ]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
fi

# Host ports (overridable in .env; defaults match the plan on a clean machine).
env_val() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2; }
API_PORT="$(env_val API_PORT)"; API_PORT="${API_PORT:-8000}"
WEB_PORT="$(env_val WEB_PORT)"; WEB_PORT="${WEB_PORT:-4200}"
MAILPIT_PORT="$(env_val MAILPIT_PORT)"; MAILPIT_PORT="${MAILPIT_PORT:-8025}"

if [ ! -f certs/zenpdf-dev.p12 ]; then
  echo "==> Generating dev signing certificate (PKCS#12)"
  mkdir -p certs
  openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem \
    -days 3650 -nodes -subj "/CN=ZenPDF Dev Signing" >/dev/null 2>&1
  openssl pkcs12 -export -out certs/zenpdf-dev.p12 -inkey certs/key.pem \
    -in certs/cert.pem -passout pass:devpass >/dev/null 2>&1
fi

echo "==> Building & starting containers..."
docker compose up -d --build

echo "==> Waiting for API + database + storage to become healthy..."
ready=0
for _ in $(seq 1 80); do
  out="$(curl -s "http://localhost:${API_PORT}/api/health/" 2>/dev/null || true)"
  if echo "$out" | grep -q '"db":true' && echo "$out" | grep -q '"storage":true'; then
    ready=1; break
  fi
  sleep 3
done
if [ "$ready" -ne 1 ]; then
  echo "ERROR: stack did not become healthy in time. Last health: ${out:-<none>}"
  echo "       Check: ./logs.sh api"
  exit 1
fi
echo "==> Enabling pg_stat_statements..."
# The `shared_preload_libraries` half is a compose command override; this is
# the other half, here rather than in /docker-entrypoint-initdb.d because that
# only fires on a *fresh* volume and every existing dev box already has one.
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-zen}" \
  -d "${POSTGRES_DB:-zenpdf}" -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" >/dev/null


echo "==> Applying migrations..."
docker compose exec -T api python manage.py migrate --noinput

echo "==> Initializing storage bucket..."
docker compose exec -T api python manage.py init_storage

echo "==> Seeding dev data..."
docker compose exec -T api python manage.py seed_dev

SEED_EMAIL="$(grep -E '^SEED_ADMIN_EMAIL=' .env | cut -d= -f2)"
SEED_PASS="$(grep -E '^SEED_ADMIN_PASSWORD=' .env | cut -d= -f2)"

cat <<EOF

===================================================================
 ZenPDF is up.
-------------------------------------------------------------------
  App          http://localhost:${WEB_PORT}
  API          http://localhost:${API_PORT}/api
  API docs     http://localhost:${API_PORT}/api/docs
  Mailpit      http://localhost:${MAILPIT_PORT}
-------------------------------------------------------------------
  Seed login   ${SEED_EMAIL:-admin@zenpdf.local} / ${SEED_PASS:-admin12345}
===================================================================
EOF
