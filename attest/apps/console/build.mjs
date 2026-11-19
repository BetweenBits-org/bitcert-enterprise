/**
 * Build — one `tsc` pass and one directory copy. No bundler.
 *
 * Nothing to flatten: the console has no framework and no dependencies, so what
 * ships is plain ES modules the browser loads directly, unminified. For a
 * surface whose job is to convince a sceptical engineer that the product is
 * what it claims, the code being readable in devtools is part of the argument.
 *
 * Unlike the Hub and the Playground, this app has no content or fixtures to
 * copy — everything it displays comes from the API at runtime, which is the
 * point: a console showing anything the API did not say would be a mock.
 *
 * The verifier is vendored as source and compiled in the same pass rather
 * than linked as a built artefact, so there is no second build to disagree
 * with this one. Two reasons it is here at all:
 *
 *   - the console is reached over plain http at an IP address, where the
 *     browser withholds `crypto.subtle`, and hashing a document locally is
 *     the thing this page exists to do;
 *   - the verify screen checks a bundle in the browser against the
 *     independent reader, not against the code that produced it.
 */
import { cp, mkdir, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const REPO = path.resolve(HERE, '../..');

const VENDOR = path.join(HERE, 'src/vendor');
const VERIFY_SRC = path.resolve(HERE, '../../packages/attest-verify/src');
const POR_SRC = path.resolve(HERE, '../../packages/attest-por/src');
const RULES_SRC = path.resolve(HERE, '../../packages/attest-rules/src');

/**
 * The part of the exchange SDK that needs nothing but the language.
 *
 * The 준비금 증명 screen reads a balance file, builds the tree and signs the
 * statement in the visitor's own page — the file and the key go no further —
 * so it runs the SDK's own rules rather than a second copy of them: the same
 * CSV dialect, the same amount conversion, the same tree. The modules that
 * touch a file system, `node:crypto` or the network stay behind; these do
 * not. `snapshot-proof.ts` is the last of them: the one file a visitor keeps
 * beside their balance file, and the rebuild of a snapshot from the two.
 */
const POR_PORTABLE = ['amounts.ts', 'csv.ts', 'ledger.ts', 'accounts-json.ts', 'sumtree.ts', 'snapshot.ts', 'portable.ts', 'snapshot-proof.ts'];

/**
 * The part of the rules engine that needs nothing but the language.
 *
 * The 검증 screen checks a settlement evidence package in the visitor's own
 * page the way the bank SDK checks it on a server: each element's signature
 * against the registry the package carries, then the six-axis engine over
 * what was found. A verdict recomputed by a second copy of the rules would
 * say nothing about the first, so the engine and the definition of the bytes
 * an issuer signs are `attest-rules`' own files. `signature.ts` is here for
 * those bytes only: its verifier calls `crypto.subtle`, which this origin
 * does not have, so the screen checks with the vendored P-256 instead.
 */
const RULES_PORTABLE = ['engine.ts', 'policy.ts', 'decimal.ts', 'types.ts', 'signature.ts'];

/**
 * The SDK's example balance file.
 *
 * The screen offers it as a download and runs it as its "try it" example, so
 * it is the package's file byte for byte — written into a module here rather
 * than typed into the screen, where a copy would drift from the file the
 * guide and the SDK's own tests use.
 *
 * One file, on purpose. The reader takes four shapes and the package ships an
 * example of each; four example links on a screen meant to be tried read as
 * four things to choose between before anything can be done. The one offered
 * is the standard shape — one row per account, one column per asset. The
 * other three are in the guide the screen links to.
 */
const POR_SAMPLES_DIR = path.resolve(HERE, '../../packages/attest-por/samples');
const POR_SAMPLES = { SAMPLE_WIDE: 'balances.wide.csv' };

/**
 * Copy the verifier's sources in. Idempotent.
 *
 * `sha256.ts` is also left at the top of `src/vendor/` because `api.ts` has
 * imported it from there since before the whole package was needed, and
 * moving it would be churn in a file that has nothing to do with this change.
 */
async function sync() {
  await rm(VENDOR, { recursive: true, force: true });
  await mkdir(path.join(VENDOR, 'attest-verify'), { recursive: true });
  for (const f of await readdir(VERIFY_SRC)) {
    if (f.endsWith('.ts')) await cp(path.join(VERIFY_SRC, f), path.join(VENDOR, 'attest-verify', f));
  }
  await cp(path.join(VERIFY_SRC, 'sha256.ts'), path.join(VENDOR, 'sha256.ts'));
  console.log('vendored attest-verify/*.ts → src/vendor/attest-verify/');

  // Both subsets name the verifier by package; a browser with no bundler can
  // only follow a path, so the specifier is pointed at the copy beside it.
  for (const [pkg, src, portable] of [['attest-por', POR_SRC, POR_PORTABLE], ['attest-rules', RULES_SRC, RULES_PORTABLE]]) {
    await mkdir(path.join(VENDOR, pkg), { recursive: true });
    for (const f of portable) {
      const source = await readFile(path.join(src, f), 'utf8');
      if (/from 'node:|\bBuffer\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, ''))) {
        throw new Error(`packages/${pkg}/src/${f} is no longer portable: it reaches for a Node API`);
      }
      await writeFile(path.join(VENDOR, pkg, f),
        source.replaceAll("from '@stonehash/attest-verify'", "from '../attest-verify/index.ts'"));
    }
    console.log(`vendored ${pkg}/{${portable.join(',')}} → src/vendor/${pkg}/`);
  }

  const samples = ['// Generated by build.mjs from packages/attest-por/samples — edit the files there, not this.'];
  for (const [name, file] of Object.entries(POR_SAMPLES)) {
    const text = await readFile(path.join(POR_SAMPLES_DIR, file), 'utf8');
    samples.push(`/** \`samples/${file}\`, as shipped with the SDK. */`,
      `export const ${name}_NAME = ${JSON.stringify(file)};`,
      `export const ${name} = ${JSON.stringify(text)};`);
  }
  await writeFile(path.join(VENDOR, 'attest-por-samples.ts'), samples.join('\n') + '\n');
  console.log(`vendored attest-por/samples/{${Object.values(POR_SAMPLES).join(',')}} → src/vendor/attest-por-samples.ts`);
}

async function build() {
  await sync();
  await rm(DIST, { recursive: true, force: true });

  // `pnpm run` puts the workspace bins on PATH; a bare `node build.mjs` does
  // not, and the resulting ENOENT names `tsc` without saying why it vanished.
  const BIN = [
    path.join(HERE, 'node_modules/.bin'),
    path.join(REPO, 'node_modules/.bin'),
  ].join(path.delimiter);

  execFileSync(
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
    ['--project', 'tsconfig.build.json'],
    { cwd: HERE, stdio: 'inherit', env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ''}` } },
  );

  await cp(path.join(HERE, 'public'), DIST, { recursive: true });

  // The page loads `./app.js` as a module. If `tsc` emitted nothing, every
  // other check here would pass and the console would be a blank page.
  const entry = await stat(path.join(DIST, 'app.js')).catch(() => null);
  if (!entry?.isFile()) throw new Error('dist/app.js was not emitted — the console would be blank');

  // A `.ts` specifier surviving into the emitted JavaScript is the one failure
  // mode of building without a bundler, and the browser reports it only as a
  // blank screen.
  const files = (await readdir(DIST, { recursive: true })).filter((f) => !f.endsWith(path.sep));
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const body = await readFile(path.join(DIST, f), 'utf8');
    for (const m of body.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
      if (m[1].endsWith('.ts')) throw new Error(`${f}: emitted a .ts specifier (${m[1]})`);
    }
  }

  console.log(`built ${files.length} files → ${path.relative(process.cwd(), DIST)}`);
}

const mode = process.argv[2] ?? 'build';
await (mode === 'sync' ? sync() : build()).catch((e) => { console.error(e); process.exit(1); });
