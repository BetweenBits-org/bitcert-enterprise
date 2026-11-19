/**
 * The ports a comparison pair runs on, read from its two settings files — so that another working copy of this
 * repository can run a pair of its own beside this one (the settings files are not in the repository; each
 * working copy has its own, with its own ports and schemas).
 *
 *   node apps/core-java/tools/test-ports.mjs <reference env file> <Java env file>
 *
 * Prints shell assignments and nothing else of the files: REF_PORT, JAVA_PORT (each server's PORT), NODE_PORT
 * (the stand-in chain node both servers are pointed at by REMIT_CHAIN_RPC), PARTNER_REF_PORT and
 * PARTNER_JAVA_PORT (each server's REMIT_PARTNERS_BASE). Exit 1 when a file does not give a port, when the two
 * servers would share one, or when they are pointed at different chain nodes.
 */
import fs from 'node:fs';

const read = (file) => {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
};
const portOf = (address) => { try { return new URL(address).port || null; } catch { return null; } };
const fail = (m) => { console.error(`test-ports: ${m}`); process.exit(1); };

const [refFile, javaFile] = process.argv.slice(2);
if (!refFile || !javaFile) fail('usage: node test-ports.mjs <reference env file> <Java env file>');
const ref = read(refFile), java = read(javaFile);
const ports = {
  REF_PORT: ref.PORT, JAVA_PORT: java.PORT,
  NODE_PORT: portOf(java.REMIT_CHAIN_RPC),
  PARTNER_REF_PORT: portOf(ref.REMIT_PARTNERS_BASE), PARTNER_JAVA_PORT: portOf(java.REMIT_PARTNERS_BASE),
};
for (const [name, port] of Object.entries(ports)) if (!/^\d{2,5}$/.test(port ?? '')) fail(`${name}: no port in the settings`);
if (portOf(ref.REMIT_CHAIN_RPC) !== ports.NODE_PORT) fail('the two servers are pointed at different chain nodes (REMIT_CHAIN_RPC)');
if (new Set(Object.values(ports)).size !== 5) fail('two of the five ports are the same');
for (const [name, port] of Object.entries(ports)) console.log(`${name}=${port}`);
