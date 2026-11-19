#!/usr/bin/env bash
# Sandbox factory reset — wipes every tenant, payment, snapshot and chain
# artifact, then re-provisions the demo estate (bank + receiving partners)
# so the next visitor starts from a clean, working corridor.
#
# Wipes: core .data (DB, platform key, PoR runs) · demo-bank state/ledgers/HSM
#        · demo-partners state/keys/ledgers · anvil chain (restart)
# Keeps: bitcoind regtest chain (orphan anchors are harmless), homepage.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CORE_URL="${ATTEST_BASE:-http://127.0.0.1:8787}"

echo "— stopping services"
pm2 stop stonehash-bank-demo stonehash-partners >/dev/null 2>&1 || true

echo "— wiping state"
# The configured data dir (core .env STONEHASH_DATA_DIR) plus the smoke
# scripts' side-state dir — both hold tenant state.
rm -rf "$REPO/attest/.data" "$REPO/attest/apps/core/.data"
# The MySQL store (the production engine). Dropping the schema is the reset;
# the service recreates every table at next boot. Credentials live beside the
# repo in deploy/mysql.env and never in this script.
if [ -f "$REPO/deploy/mysql.env" ]; then
  # shellcheck disable=SC1091
  . "$REPO/deploy/mysql.env"
  DBNAME="${STONEHASH_DB_URL##*/}"
  mysql -h127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" \
    -e "DROP DATABASE IF EXISTS \`$DBNAME\`; CREATE DATABASE \`$DBNAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;" 2>/dev/null \
    && echo "— mysql: $DBNAME dropped & recreated" \
    || echo "— mysql: unreachable (skipped — SQLite fallback only)"
fi
rm -f  "$REPO/demo-bank/state.json"
rm -f  "$REPO/demo-bank/data/records.json" "$REPO/demo-bank/data/remit-cases.json" "$REPO/demo-bank/data/remit-state.json"
rm -rf "$REPO/demo-bank/work" && mkdir -p "$REPO/demo-bank/work"
rm -f  "$REPO/demo-partners/state.json"
rm -rf "$REPO/demo-partners/keys" "$REPO/demo-partners/data"
mkdir -p "$REPO/demo-partners/keys" "$REPO/demo-partners/data"
rm -rf "$REPO/attest/quickstart/out"
rm -f  "$REPO/demo-customers/state.json"
rm -rf "$REPO/demo-customers/data" && mkdir -p "$REPO/demo-customers/data"

echo "— fresh chain + fresh core"
pm2 restart stonehash-anvil >/dev/null 2>&1
pm2 restart stonehash-attest-core >/dev/null 2>&1
for i in $(seq 1 30); do curl -sf "$CORE_URL/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$CORE_URL/healthz" >/dev/null || { echo "core did not come up" >&2; exit 1; }

echo "— provisioning demo bank"
(cd "$REPO/demo-bank" && node setup.mjs)
pm2 restart stonehash-bank-demo >/dev/null 2>&1
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:3200/api/config" >/dev/null 2>&1 && break; sleep 1; done
curl -sf -X POST "http://127.0.0.1:3200/api/remit/subscribe" >/dev/null \
  || echo "  (warn) bank remit subscription failed — activate from the bank screen"

echo "— provisioning the three-customer portal"
(cd "$REPO/demo-customers" && node setup.mjs)
pm2 restart stonehash-customers >/dev/null 2>&1 || true

echo "— provisioning receiving partners"
(cd "$REPO/demo-partners" && node setup.mjs)
pm2 restart stonehash-partners >/dev/null 2>&1
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:3300/healthz" >/dev/null 2>&1 && break; sleep 1; done

echo "— health"
curl -s "$CORE_URL/readyz" | head -c 120; echo
curl -s "http://127.0.0.1:3300/wallet/state" | head -c 200; echo
echo "✓ sandbox reset — clean corridor, zero transactions"
