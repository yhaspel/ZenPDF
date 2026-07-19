#!/usr/bin/env bash
# Stop the stack (keep volumes).
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
