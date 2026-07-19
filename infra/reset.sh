#!/usr/bin/env bash
# DESTRUCTIVE: tear down + wipe all volumes (db, storage), then bring up fresh.
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" != "--yes" ]; then
  read -r -p "This DELETES all data (database + object storage). Continue? [y/N] " ans
  case "$ans" in
    y|Y) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

echo "==> Tearing down and removing volumes..."
docker compose down -v
exec ./up.sh
