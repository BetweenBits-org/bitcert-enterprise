#!/usr/bin/env bash
# R2 exception-matrix smoke. Needs core :8787 + partners :3300 + demo-bank :3200.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for port in 8787 3300 3200; do
  curl -sf "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1 \
    || curl -sf "http://127.0.0.1:${port}/api/remit/config" >/dev/null 2>&1 \
    || { echo "service on :${port} not up" >&2; exit 1; }
done
exec node "$HERE/smoke-exceptions.mjs"
