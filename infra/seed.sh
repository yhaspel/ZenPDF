#!/usr/bin/env bash
# Re-run dev data seeding.
set -euo pipefail
cd "$(dirname "$0")"
docker compose exec -T api python manage.py seed_dev
