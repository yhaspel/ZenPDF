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
# `--profile "*"` or a container started under a profile (perf, flower)
# survives teardown and blocks the network removal with "Resource is
# still in use".
docker compose --profile "*" down -v
exec ./up.sh
