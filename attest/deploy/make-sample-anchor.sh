#!/usr/bin/env bash
# Regenerate the Playground's anchored sample against a running regtest node.
#
# Produces `apps/playground/assets/anchored.{txt,bundle.json}` — a real document
# hashed, batched, anchored and exported, not a hand-written fixture. The batch
# is padded with sibling leaves so the inclusion proof has a path to fold; a
# single-leaf tree would leave the Evidence tab with nothing to display.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=_env.sh
source "$ROOT/deploy/_env.sh"
_load_env "$ROOT/apps/core"
_require_node

cd "$ROOT/apps/core"
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadConfig } from "./src/config.ts";
import { openDb } from "./src/db.ts";
import { AttestService } from "./src/service.ts";
import { BitcoindAnchorBackend } from "./src/anchor/bitcoind.ts";
import { verifyBundle } from "@stonehash/attest-verify";

const [doc, out] = process.argv.slice(1);
const bytes = new Uint8Array(readFileSync(doc));
const digest = createHash("sha256").update(bytes).digest("hex");

const cfg = loadConfig();
const backend = new BitcoindAnchorBackend({ network: cfg.bitcoinNetwork, ...cfg.bitcoind });
const svc = new AttestService(openDb(cfg.dbPath), backend, cfg.batch.maxLeaves);
const org = svc.ensureOrg("playground-sample", "Playground sample");

const att = svc.issue(org, digest, "text/plain", { ref: "SAMPLE" });
for (let i = 0; i < 4; i++) {
  svc.issue(org, createHash("sha256").update("sibling " + Date.now() + " " + i).digest("hex"));
}
const batch = svc.sealBatch();
const txid = await svc.anchorBatch(batch);
if (cfg.bitcoinNetwork === "regtest") await backend.generate(2);
await svc.refreshConfirmations();

const bundle = svc.exportBundle(org, att.id);
writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n");
const r = verifyBundle(bundle, { originalBytes: bytes });
console.log(JSON.stringify({
  txid, merklePathLength: bundle.merkle.siblings.length,
  network: bundle.bitcoin_network, verified: r.verified, links: r.links,
}, null, 2));
if (!r.verified) process.exit(1);
if (bundle.merkle.siblings.length < 2) {
  console.error("refusing: the Merkle path is too short for the Evidence tab to show anything");
  process.exit(1);
}
' "$ROOT/apps/playground/assets/anchored.txt" "$ROOT/apps/playground/assets/anchored.bundle.json" \
  2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings

echo "regenerated apps/playground/assets/anchored.bundle.json"
