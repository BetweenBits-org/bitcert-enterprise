/**
 * The platform signing key of a test server, made by the reference's own code.
 *
 *   node apps/core-java/tools/make-test-platform-key.mjs <env file>
 *
 * Reads `REMIT_PLATFORM_KEY_PATH` from a settings file of this module and calls the reference's
 * `loadOrCreatePlatformKey` on it: a file that is there is kept and read, one that is not is made (PKCS#8 PEM,
 * readable by its owner only). Prints the key's id — public — and never the key.
 *
 * Why it exists: the two comparison servers share one key file, so that `GET /v1/remit/meta` is the same on both
 * and what one signed the other can verify; and the Java service's tests are wired, not started to serve, so they
 * never make a key themselves (design 10). The rail's seed makes the same file the same way; whichever runs first
 * makes it, the other keeps it.
 *
 * Refuses a settings file that is not safe for a test server (tools/check-test-env.mjs), and a path outside this
 * module's own folder: nothing here can touch the live key.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { problems, readEnvFile } from './check-test-env.mjs';
import { loadOrCreatePlatformKey } from '../../core/src/remit/sign.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '..');
const [envFile] = process.argv.slice(2);
if (!envFile) { console.error('usage: node make-test-platform-key.mjs <env file>'); process.exit(2); }
const full = path.resolve(envFile);
if (path.dirname(full) !== MODULE || !path.basename(full).startsWith('.env.')) { console.error(`${envFile}: not a settings file of this module (apps/core-java/.env.*)`); process.exit(1); }
const env = readEnvFile(full);
const found = problems(env);
if (found.length) { for (const p of found) console.error(`${path.basename(full)}: ${p}`); process.exit(1); }
if (!env.REMIT_PLATFORM_KEY_PATH) { console.error(`${path.basename(full)}: REMIT_PLATFORM_KEY_PATH is not set`); process.exit(1); }
const file = path.resolve(MODULE, env.REMIT_PLATFORM_KEY_PATH);
if (!file.startsWith(`${MODULE}${path.sep}`)) { console.error('refusing: REMIT_PLATFORM_KEY_PATH is outside apps/core-java'); process.exit(1); }
const was = existsSync(file);
const key = loadOrCreatePlatformKey(file);
console.log(`${was ? 'kept' : 'made'} ${path.relative(MODULE, file)} — key id ${key.keyId}`);
