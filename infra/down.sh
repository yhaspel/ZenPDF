#!/usr/bin/env bash
# Stop the stack (keep volumes).
set -euo pipefail
cd "$(dirname "$0")"
# `--profile "*"` or a container started under a profile (perf, flower)
# survives teardown and blocks the network removal with "Resource is
# still in use".
docker compose --profile "*" down
