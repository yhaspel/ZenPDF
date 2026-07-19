#!/usr/bin/env bash
# Restart the whole stack without wiping volumes.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
exec ./up.sh
