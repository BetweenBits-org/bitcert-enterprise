/**
 * One-time provisioning for the demo bank — the steps a real bank's ops
 * team would do by hand, scripted so the demo is reproducible:
 *
 *   1. mint the "HSM" key        (openssl, stands in for the real hardware)
 *   2. open a sandbox account    (POST /v1/console/signup — returns the API key)
 *   3. register the public half  (POST /v1/console/issuer-keys, session cookie)
 *
 * Everything lands in state.json (0600). Idempotent: refuses to run twice.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'state.json');
const CORE = process.env.ATTEST_BASE ?? 'http://127.0.0.1:8787';

if (existsSync(STATE)) {
  console.error('state.json already exists — delete it to re-provision.');
  process.exit(1);
}

// ── 1. the "HSM": a P-256 key openssl holds, never passed to anything else ──
const keyFile = path.join(HERE, 'hsm', 'bank-hsm.key');
const pubFile = path.join(HERE, 'hsm', 'issuer-public.pem');
execFileSync('openssl', ['genpkey', '-algorithm', 'EC',
  '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', keyFile]);
chmodSync(keyFile, 0o600);
execFileSync('openssl', ['pkey', '-in', keyFile, '-pubout', '-out', pubFile]);
const spkiBase64 = readFileSync(pubFile, 'utf8')
  .replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

// ── 2. sandbox account; the signup response carries the API key, once ──────
const email = 'ops@demo-bank.example';
const password = randomBytes(18).toString('base64url');
const signupRes = await fetch(`${CORE}/v1/console/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const signup = await signupRes.json();
if (signupRes.status !== 201) {
  console.error('signup failed:', signupRes.status, JSON.stringify(signup));
  process.exit(1);
}
const cookie = signupRes.headers.get('set-cookie')?.split(';')[0];
if (!cookie || !signup.api_key_secret) {
  console.error('signup response missing session cookie or api key');
  process.exit(1);
}

// ── 3. vouch for the key — the governance step, done here by the script ────
const regRes = await fetch(`${CORE}/v1/console/issuer-keys`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({
    public_key: spkiBase64,
    label: '데모은행 HSM (P-256)',
    algorithm: 'ES256',
  }),
});
const reg = await regRes.json();
if (regRes.status !== 201 && regRes.status !== 200) {
  console.error('issuer-key registration failed:', regRes.status, JSON.stringify(reg));
  process.exit(1);
}

writeFileSync(STATE, `${JSON.stringify({
  provisionedAt: new Date().toISOString(),
  core: CORE,
  email,
  password,
  apiKey: signup.api_key_secret,
  issuerKey: { id: reg.id ?? reg.key?.id ?? null, spkiBase64, algorithm: 'ES256' },
}, null, 2)}\n`);
chmodSync(STATE, 0o600);
console.log(`provisioned: ${email}  issuer key registered  api key ${signup.api_key_secret.slice(0, 12)}…`);
