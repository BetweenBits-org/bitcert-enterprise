#!/usr/bin/env bash
# Start the remit demo estate: anvil + demo-partners (+ provisioning on first run).
# The core must already be running (deploy/run-core.sh) for registration to land.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"

command -v anvil >/dev/null || { echo "anvil not found — install foundry, or run demo-partners with CHAIN_BACKEND=mock" >&2; exit 1; }

if ! curl -sf -X POST http://127.0.0.1:8545 -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' >/dev/null 2>&1; then
  echo "starting anvil :8545"
  pm2 start anvil --name stonehash-anvil -- --port 8545 --chain-id 31337 --silent
  sleep 2
fi

if [[ ! -f "$REPO/demo-partners/state.json" ]]; then
  echo "provisioning partner estate (keys + Trust Registry registration)"
  (cd "$REPO/demo-partners" && node setup.mjs)
fi

pm2 start "$REPO/demo-partners/server.mjs" --name stonehash-partners --cwd "$REPO/demo-partners" 2>/dev/null \
  || pm2 restart stonehash-partners
pm2 save >/dev/null
echo "demo-partners on :3300 — UI http://127.0.0.1:3300/"
