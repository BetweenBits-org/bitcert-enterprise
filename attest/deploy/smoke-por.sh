#!/usr/bin/env bash
# PoR mode-C end-to-end smoke. Needs core :8787 + bitcoind regtest.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
curl -sf http://127.0.0.1:8787/healthz >/dev/null || { echo "core :8787 not up" >&2; exit 1; }
exec node "$HERE/smoke-por.mjs"
