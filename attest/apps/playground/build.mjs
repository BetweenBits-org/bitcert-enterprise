/**
 * Build — one `tsc` pass and two directory copies. No bundler.
 *
 * ## Why there is nothing to bundle
 *
 * The verifier has zero dependencies and the Playground has no framework, so a
 * bundler would have no module graph to flatten. The one thing it used to be
 * needed for was rewriting the `./sha256.ts` import specifiers into `.js`, and
 * TypeScript 5.7 does that itself with `rewriteRelativeImportExtensions`.
 *
 * What ships is plain ES modules the browser loads directly, unminified. For a
 * tool whose entire claim is "check this yourself", the code a visitor reads in
 * devtools being the code that verified their proof is part of the product.
 *
 * ## Why the SDK is vendored as source
 *
 * The verifier's `.ts` sources are copied into `src/vendor/` and compiled with
 * the Playground in a single pass. Compiling them separately would mean the
 * Playground typechecks against `.d.ts` files while running against emitted
 * `.js` — two artefacts that can disagree. One pass over real sources cannot.
 */
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const VENDOR_ROOT = path.join(HERE, 'src/vendor');
/**
 * The verifier is vendored as source and compiled with the Playground in one
 * pass. The rules engine and the archive assembler used to be vendored too,
 * for the Bank Review and Corridor tabs; those tabs are gone and the page no
 * longer ships either package. Both remain in the workspace — the service's
 * settlement endpoints use them — this page just stopped carrying them.
 */
const VENDORED = [
  { name: 'attest-verify', src: path.resolve(HERE, '../../packages/attest-verify/src') },
];

/** Refresh the vendored package sources. Called by `build` and by `sync`. */
export async function sync() {
  await rm(VENDOR_ROOT, { recursive: true, force: true });
  for (const { name, src } of VENDORED) {
    const dest = path.join(VENDOR_ROOT, name);
    await mkdir(dest, { recursive: true });
    await cp(src, dest, { recursive: true });
    // Bare package specifiers → relative sibling paths, so the browser resolves
    // them without an import map or a bundler.
    //
    // Line-based, skipping comment lines. The docstrings carry usage examples
    // that are themselves `import … from '@stonehash/attest-verify'`, and a
    // regex over the whole file rewrote those too — producing emitted output
    // whose comments looked like broken imports.
    for (const f of await readdir(dest)) {
      if (!f.endsWith('.ts')) continue;
      const p = path.join(dest, f);
      const before = await readFile(p, 'utf8');
      const after = before.split('\n').map((line) => {
        const t = line.trimStart();
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return line;
        return line
          .replace(/(\b(?:from|import)\s*)(['"])@stonehash\/attest-verify\2/g,
            "$1'../attest-verify/index.ts'")
          .replace(/(\b(?:from|import)\s*)(['"])@stonehash\/attest-rules\2/g,
            "$1'../attest-rules/index.ts'");  // kept: harmless if the engine returns
      }).join('\n');
      if (after !== before) await writeFile(p, after);
    }
    console.log(`vendored @stonehash/${name} → ${path.relative(HERE, dest)}`);
  }
}

async function build() {
  await sync();

  // `pnpm run` puts the workspace bins on PATH; a bare `node build.mjs` does
  // not. The compiler is looked for here first, and before the old build is
  // removed: on 2026-11-18 a bare run deleted `dist`, failed to find `tsc`,
  // and left the public page answering 404 until it was built again.
  const BIN = [
    path.join(HERE, 'node_modules/.bin'),
    path.resolve(HERE, '../../node_modules/.bin'),
  ].join(path.delimiter);
  const env = { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ''}` };
  const tsc = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  execFileSync(tsc, ['--version'], { cwd: HERE, stdio: 'ignore', env });

  await rm(DIST, { recursive: true, force: true });

  execFileSync(tsc, ['--project', 'tsconfig.build.json'], { cwd: HERE, stdio: 'inherit', env });

  // `public/` is the page itself. `assets/` holds a really-anchored bundle and
  // the document it commits; those used to ship too, for a "load a sample"
  // button. The button is gone — step 1 hands a visitor a real proof of their
  // own in about a quarter of a minute, which is a better demonstration than a
  // fixture — so the fixtures stay where they are and serve the tests only.
  await cp(path.join(HERE, 'public'), DIST, { recursive: true });


  const files = await readdir(DIST, { recursive: true });
  console.log(`built ${files.filter((f) => !f.endsWith(path.sep)).length} files → ${path.relative(process.cwd(), DIST)}`);
}

const mode = process.argv[2] ?? 'build';
await (mode === 'sync' ? sync() : build()).catch((e) => { console.error(e); process.exit(1); });
