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

echo "==> Checking the workers are not older than the code they run..."
# Celery does not hot-reload, and `docker compose up -d --build` above recreates
# a container only when its image or definition changed — so a stack left up
# across a backend edit silently keeps running the old task code. That is how
# `phase-2b:130` was misdiagnosed twice in one day against workers that were ten
# days stale (PROGRESS, 2026-08-21); a false *pass* is the worse half of it and
# would never be noticed at all.
#
# This only says so. Restarting belongs to `test.sh --e2e`, which is the place
# that is about to depend on the answer — `up.sh` is also run to *get back to* a
# stack somebody is using, and killing their in-flight job to make a point is
# not an improvement.
stale_workers="$(
  python3 - <<'PY'
import datetime
import os
import subprocess

# "The newest file under backend/" has to mean the newest *source* file, and
# git already knows which those are. Walking the directory instead does not
# work: celery beat writes `celerybeat-schedule-shm` in there every few seconds,
# so the newest file under backend/ is always younger than any worker and the
# warning would fire on every single run — which is how a warning stops being
# read. `--others --exclude-standard` keeps a file you have just written and not
# yet added, while .gitignore keeps out the caches and the runtime state.
listing = subprocess.run(
    ['git', '-C', '..', 'ls-files', '-z', '--cached', '--others',
     '--exclude-standard', 'backend'],
    capture_output=True, text=True)
if listing.returncode != 0:
    raise SystemExit(0)

newest = 0.0
for rel in listing.stdout.split('\0'):
    if not rel:
        continue
    try:
        newest = max(newest, os.stat(os.path.join('..', rel)).st_mtime)
    except OSError:
        pass


def started_at(container):
    raw = subprocess.run(['docker', 'inspect', '-f', '{{.State.StartedAt}}', container],
                         capture_output=True, text=True).stdout.strip()
    if not raw:
        return None
    # RFC3339 with nanoseconds; datetime stops at microseconds.
    if '.' in raw:
        head, _, tail = raw.partition('.')
        raw = f"{head}.{''.join(c for c in tail if c.isdigit())[:6]}+00:00"
    else:
        raw = raw.replace('Z', '+00:00')
    try:
        return datetime.datetime.fromisoformat(raw).timestamp()
    except ValueError:
        return None


for service in ('worker-default', 'worker-heavy', 'worker-render', 'beat'):
    cid = subprocess.run(['docker', 'compose', 'ps', '-q', service],
                         capture_output=True, text=True).stdout.strip()
    if not cid:
        continue
    when = started_at(cid)
    if when is not None and when < newest:
        print(service)
PY
)"
if [ -n "$stale_workers" ]; then
  for svc in $stale_workers; do
    printf '\033[33m    WARNING: %s started before the newest backend change — restart it\033[0m\n' "$svc"
  done
  printf '\033[33m             docker compose -f infra/docker-compose.yml restart %s\033[0m\n' \
    "$(echo "$stale_workers" | tr '\n' ' ')"
else
  echo "    workers are newer than the newest file under backend/."
fi

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
