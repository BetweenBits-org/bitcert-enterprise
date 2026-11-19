#!/usr/bin/env bash
# End-to-end smoke test against a running Attest Core.
#
# Issues an attestation for a throwaway document, seals and anchors it, mines a
# block, exports the bundle and verifies it with the independent verifier. If
# this passes, the deployment works — not just the unit tests.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=_env.sh
source "$ROOT/deploy/_env.sh"
# The seal/anchor step below opens the service's own database and node, so it
# must see exactly the configuration the service was started with.
_load_env "$ROOT/apps/core"
_require_node

BASE="${BASE:-http://127.0.0.1:8787}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '\n== %s\n' "$1"; }

say "service metadata"
curl -fsS "$BASE/v1/meta"

say "sandbox sign-up"
KEY="$(curl -fsS -X POST "$BASE/v1/sandbox/keys" -H 'content-type: application/json' \
       -d '{"slug":"smoke"}' | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).api_key')"
printf 'key: %s…\n' "${KEY:0:16}"

say "issue an attestation (the document is hashed locally and never uploaded)"
printf 'smoke test %s' "$(date -u +%FT%TZ)" > "$WORK/doc.txt"
DIGEST="$(node -e 'const{createHash}=require("node:crypto");process.stdout.write(createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$WORK/doc.txt")"
ID="$(curl -fsS -X POST "$BASE/v1/attestations" -H "authorization: Bearer $KEY" \
      -H 'content-type: application/json' -d "{\"leaf_bytes\":\"$DIGEST\"}" \
      | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"
printf 'attestation: %s\n' "$ID"

say "seal, anchor, confirm"
cd "$ROOT/apps/core"
node --input-type=module -e '
import { loadConfig } from "./src/config.ts";
import { openDb } from "./src/db.ts";
import { AttestService } from "./src/service.ts";
import { BitcoindAnchorBackend } from "./src/anchor/bitcoind.ts";
const cfg = loadConfig();
const backend = new BitcoindAnchorBackend({ network: cfg.bitcoinNetwork, ...cfg.bitcoind });
const svc = new AttestService(openDb(cfg.dbPath), backend, cfg.batch.maxLeaves);
const batch = svc.sealBatch();
if (batch) console.log("sealed", batch, "txid", await svc.anchorBatch(batch));
if (cfg.bitcoinNetwork === "regtest") await backend.generate(1);
console.log("confirmed", await svc.refreshConfirmations());
' 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings

say "export the bundle"
curl -fsS "$BASE/v1/attestations/$ID/bundle" -H "authorization: Bearer $KEY" > "$WORK/bundle.json"
node -e 'const b=require(process.argv[1]);console.log(JSON.stringify({schema:b.schema,network:b.bitcoin_network,txid:b.anchor.reveal_txid,root:b.merkle.root},null,2))' "$WORK/bundle.json"

say "verify with the independent verifier"
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { verifyBundle } from "@stonehash/attest-verify";
const bundle = JSON.parse(readFileSync(process.argv[1], "utf8"));
const r = verifyBundle(bundle, { originalBytes: new Uint8Array(readFileSync(process.argv[2])) });
for (const c of r.checks) console.log(" ", c.state.toUpperCase().padEnd(5), c.id);
console.log("\n  verified:", r.verified, "\n  links:   ", JSON.stringify(r.links));
if (!r.verified) process.exit(1);
' "$WORK/bundle.json" "$WORK/doc.txt" 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings

printf '\nSMOKE OK\n'
