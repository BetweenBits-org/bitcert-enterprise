#!/usr/bin/env bash
#
# Start (or replace) the settlement-chain explorer: Otterscan on :5106.
#
# Needs the read-only gateway on 127.0.0.1:5107 (pm2 app `stonehash-evm-gateway`,
# deploy/ecosystem.config.cjs). Host networking so nginx can reach the gateway
# on loopback; the gateway, and anvil behind it, stay unreachable from outside.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC="${EXPLORER_PUBLIC_URL:-http://3.36.101.90:5106}"
# The image's chain table calls 31337 "GoChain Testnet"; name the chain ourselves.
CONFIG=$(node -e '
  const url = process.argv[1];
  console.log(JSON.stringify({
    erigonURL: `${url}/rpc`,
    assetsURLPrefix: url,
    chainInfo: { name: "StoneHash Sandbox — USDC settlement chain", faucets: [],
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
  }));' "$PUBLIC")
docker rm -f stonehash-evm-explorer >/dev/null 2>&1 || true
docker run -d --name stonehash-evm-explorer --restart unless-stopped --network host \
  -v "$HERE/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  -e OTTERSCAN_CONFIG="$CONFIG" \
  otterscan/otterscan:latest
