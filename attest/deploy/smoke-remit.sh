#!/usr/bin/env bash
# End-to-end remit smoke: core + partners + anvil + regtest must be running.
# Plays the bank: subscribe → quote → sign → settle → … → EVIDENCE_ANCHORED
# → independent verification of the package and its Bitcoin anchor.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
curl -sf http://127.0.0.1:8787/healthz >/dev/null || { echo "core :8787 not up" >&2; exit 1; }
curl -sf http://127.0.0.1:3300/healthz >/dev/null || { echo "demo-partners :3300 not up (deploy/run-partners.sh)" >&2; exit 1; }
exec node "$HERE/smoke-remit.mjs"
