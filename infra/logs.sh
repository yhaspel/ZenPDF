#!/usr/bin/env bash
# Tail logs for all services, or one: ./logs.sh api
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = "" ]; then
  docker compose logs -f
else
  docker compose logs -f "$1"
fi
