#!/usr/bin/env bash
#
# Point Attest at the bitcoind the mempool explorer indexes.
#
# There are two regtest nodes on this host and they are different chains:
#
#   :18556  the node Attest has anchored to so far          (its own datadir)
#   :18443  the node `explorer-web-1` on :3002 indexes      (shared stack)
#
# Anchors made against the first are invisible to the explorer, which is why
# the console has been withholding the "멤풀에서 보기" link. This moves Attest
# onto the second so new anchors resolve there.
#
# ## What this does NOT fix
#
# Records already in the database point at transactions on the old chain. The
# new node has never seen them, so their lookup will say so and no explorer
# link will appear for them — which is correct, and is why the link is driven
# by the lookup rather than by configuration.
#
# ## Why a script and not just an edit
#
# The `attest` wallet on :18443 exists but is empty, and the block subsidy on
# that chain is already zero (regtest halves every 150 blocks; it is past
# height 9000), so mining cannot fund it. The only funded wallet there is
# `beecert`, so the coins have to come from it. That is a value transfer, and
# it belongs in something a human runs deliberately rather than in a tool call.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/core/.env"
FUND_BTC="${FUND_BTC:-10}"
EXPLORER="${EXPLORER:-http://3.36.101.90:3002}"

CLI=(bitcoin-cli -regtest -rpcconnect=127.0.0.1 -rpcport=18443
     -rpcuser=regtest -rpcpassword=regtest)

echo "── checking the target node ──────────────────────────────────────────"
"${CLI[@]}" getblockchaininfo | grep -E '"chain"|"blocks"'

# Idempotent: creating a wallet that exists is an error, loading it is not.
"${CLI[@]}" createwallet attest >/dev/null 2>&1 || "${CLI[@]}" loadwallet attest >/dev/null 2>&1 || true

BAL=$("${CLI[@]}" -rpcwallet=attest getbalance)
echo "attest wallet balance: $BAL"

if (( $(echo "$BAL < 1" | bc -l) )); then
  ADDR=$("${CLI[@]}" -rpcwallet=attest getnewaddress funding)
  echo "── funding $FUND_BTC BTC from beecert → $ADDR ────────────────────────"
  TXID=$("${CLI[@]}" -rpcwallet=beecert sendtoaddress "$ADDR" "$FUND_BTC")
  echo "funding txid: $TXID"
  # Two blocks so the funding is confirmed and immediately spendable.
  "${CLI[@]}" generatetoaddress 2 "$("${CLI[@]}" -rpcwallet=beecert getnewaddress)" >/dev/null
  echo "attest wallet balance: $("${CLI[@]}" -rpcwallet=attest getbalance)"
else
  echo "already funded; skipping the transfer"
fi

echo "── rewriting $ENV_FILE ───────────────────────────────────────────────"
cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
python3 - "$ENV_FILE" "$EXPLORER" <<'PY'
import sys, io
path, explorer = sys.argv[1], sys.argv[2]
want = {
    'BITCOIND_URL': 'http://127.0.0.1:18443',
    'BITCOIND_USER': 'regtest',
    'BITCOIND_PASSWORD': 'regtest',
    'BITCOIND_WALLET': 'attest',
    'EXPLORER_BASE_URL': explorer,
}
lines, seen = [], set()
for line in io.open(path, encoding='utf-8').read().split('\n'):
    key = line.split('=', 1)[0].strip()
    if key in want:
        lines.append(f'{key}={want[key]}'); seen.add(key)
    else:
        lines.append(line)
for key, value in want.items():
    if key not in seen:
        lines.append(f'{key}={value}')
io.open(path, 'w', encoding='utf-8').write('\n'.join(lines))
print('  ' + '\n  '.join(f'{k}={v}' for k, v in want.items()))
PY

echo "── restarting ────────────────────────────────────────────────────────"
# `pm2 restart` reuses the environment pm2 captured at first start, so an
# edited .env would be ignored. `pm2 start` on the ecosystem file re-reads it.
pm2 start "$ROOT/deploy/ecosystem.config.cjs" >/dev/null
sleep 3
curl -s http://127.0.0.1:8787/healthz
echo
curl -s http://127.0.0.1:8787/v1/meta | python3 -c 'import json,sys; d=json.load(sys.stdin); print("network:", d.get("bitcoin_network"), "| anchor backend:", d.get("anchor_backend"))' 2>/dev/null || true
echo "done."
