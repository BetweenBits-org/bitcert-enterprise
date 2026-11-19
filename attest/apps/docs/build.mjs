/**
 * Build — one `tsc` pass and some file copying. No bundler.
 *
 * ## Why there is nothing to bundle
 *
 * The hub has no framework and no dependencies, so a bundler would have no
 * module graph to flatten. What ships is plain ES modules the browser loads
 * directly, unminified: for a site whose argument is that our claims can be
 * checked without trusting our toolchain, the code a reader finds in devtools
 * being the code that rendered the page is part of the point.
 *
 * ## Why the specification is copied rather than kept here
 *
 * `fixtures/bundle-schema.md` is the authoritative wire contract, shared with
 * the producer, the verifier and the conformance fixtures. A second copy under
 * `content/` would go stale the moment a field changed — and the stale copy is
 * the one a regulator would be reading. `test/content.test.ts` asserts the
 * duplicate does not exist.
 */
import { cp, mkdir, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const REPO = path.resolve(HERE, '../..');

/** Documents copied in from elsewhere in the repository, with their reason. */
const IMPORTED = [
  {
    from: path.join(REPO, 'fixtures/bundle-schema.md'),
    to: 'content/bundle-schema.md',
    why: 'the authoritative wire contract — published verbatim, never duplicated',
  },
];

/**
 * Pack the signing SDK for download, and checksum it.
 *
 * Built here rather than committed so the tarball can never be a stale copy
 * of the sources beside it — the hub would otherwise be handing out a signer
 * that disagrees with the verifier it ships next to, which is the one
 * disagreement this whole design is arranged to prevent.
 *
 * `--sort=name --mtime --owner --group --numeric-owner` make the archive
 * reproducible: the same sources produce the same bytes and the same digest,
 * so a reader can rebuild it and compare instead of trusting the file.
 */
/**
 * Every customer-facing SDK ships the same way: repo-relative layout, the
 * \`@stonehash/*\` dependencies vendored as the same zero-dependency sources
 * via the workspace symlinks, reproducible bytes, a checksum beside the
 * file. One list, three tarballs — adding a rail means adding an entry,
 * not another bespoke packer.
 */
const SDK_TARBALLS = [
  {
    file: 'attest-remit.tar.gz',
    // A bank applies this SDK inside its own system's source; what it downloads
    // is the library, not something to operate from a terminal. The command
    // line, the folder watcher and the run-it-yourself script stay in the
    // repository as internal test tools and are left out of the archive.
    exclude: ['packages/attest-remit/src/cli.ts', 'packages/attest-remit/src/adapter.ts'],
    entries: [
      'packages/attest-remit/src', 'packages/attest-remit/package.json',
      // The sample SWIFT messages and customer-master extract the guide's
      // examples read, and the page a reader opens first after extracting.
      'packages/attest-remit/samples', 'packages/attest-remit/README.md',
      'packages/attest-remit/node_modules/@stonehash/attest-verify',
      'packages/attest-remit/node_modules/@stonehash/attest-rules',
      'packages/attest-rules/src', 'packages/attest-rules/package.json',
      'packages/attest-rules/node_modules/@stonehash/attest-verify',
      'packages/attest-verify/src', 'packages/attest-verify/package.json',
    ],
  },
  {
    file: 'attest-por.tar.gz',
    // As with the bank SDK: an exchange applies this inside its own system's
    // source, and downloads the library. The command line and the
    // run-it-yourself script stay in the repository as internal test tools.
    exclude: ['packages/attest-por/src/cli.ts'],
    entries: [
      'packages/attest-por/src', 'packages/attest-por/package.json',
      // The example balance files and export queries the guide's code and
      // text refer to, and the page a reader opens first after extracting.
      'packages/attest-por/samples', 'packages/attest-por/README.md',
      'packages/attest-por/node_modules/@stonehash/attest-verify',
      'packages/attest-por/node_modules/@stonehash/attest-rules',
      'packages/attest-rules/src', 'packages/attest-rules/package.json',
      'packages/attest-rules/node_modules/@stonehash/attest-verify',
      'packages/attest-verify/src', 'packages/attest-verify/package.json',
    ],
  },
  {
    file: 'attest-remit-java.tar.gz',
    // The bank SDK for a bank whose systems are Java. What it downloads is the
    // released jar with its sources jar and pom, the sources and the vectors
    // they are held to, the examples, and the sample messages the TypeScript
    // SDK ships too (the examples read them by the same path).
    //
    // `release/` is what `sdks/attest-remit-java/release.sh` last cut, and it
    // cuts one only when every test passes. `dist/` and `build/` are what a
    // build — also a failed one — leaves behind, and are never packed. The
    // vector generators under `tools/` need the TypeScript packages, which this
    // archive does not carry, and stay in the repository with `release.sh`.
    release: 'sdks/attest-remit-java/release',
    entries: [
      'sdks/attest-remit-java/release', 'sdks/attest-remit-java/src', 'sdks/attest-remit-java/examples',
      'sdks/attest-remit-java/README.md', 'sdks/attest-remit-java/build.sh', 'sdks/attest-remit-java/run-tests.sh',
      'packages/attest-remit/samples',
    ],
  },
];

/**
 * A tarball that packs a release is only as good as the release beside it.
 *
 * Checked before anything is removed: `build()` starts by deleting `dist`, and
 * a build that then stopped for want of a jar would leave the hub — which the
 * core serves straight from `dist` — answering 404 until the next good build.
 * So a release that is missing, or whose files are not the ones its own
 * `SHA256SUMS` lists (one cut half-way, or edited by hand), stops the build
 * here, with the published site untouched.
 */
async function assertReleases() {
  for (const { file, release } of SDK_TARBALLS) {
    if (!release) continue;
    const dir = path.join(REPO, release);
    const sums = await readFile(path.join(dir, 'SHA256SUMS'), 'utf8').catch(() => null);
    if (sums === null) {
      throw new Error(`${file}: ${release}/SHA256SUMS is not there — cut a release first (${path.dirname(release)}/release.sh). Nothing was removed.`);
    }
    const listed = sums.split('\n').filter((l) => l.trim()).map((l) => l.trim().split(/\s+/));
    if (listed.length === 0 || !listed.some(([, name]) => name?.endsWith('.jar'))) {
      throw new Error(`${file}: ${release}/SHA256SUMS lists no jar. Nothing was removed.`);
    }
    for (const [digest, name] of listed) {
      const bytes = await readFile(path.join(dir, name ?? '')).catch(() => null);
      if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== digest) {
        throw new Error(`${file}: ${release}/${name} is missing or is not the file SHA256SUMS lists — cut the release again. Nothing was removed.`);
      }
    }
  }
}

async function packOne(out, file, entries, exclude = []) {
  const tarball = path.join(out, file);
  execFileSync('tar', [
    '--sort=name', '--mtime=UTC 2020-01-01', '--owner=0', '--group=0', '--numeric-owner',
    ...exclude.map((e) => `--exclude=${e}`),
    '-czf', tarball, '-C', REPO, ...entries,
  ]);
  const digest = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await writeFile(path.join(out, file.replace(/\.tar\.gz$/, '.sha256')), `${digest}  ${file}\n`);
  return { file, bytes: (await stat(tarball)).size, digest };
}

async function packSdk() {
  const out = path.join(DIST, 'download');
  await mkdir(out, { recursive: true });
  for (const { file, entries, exclude } of SDK_TARBALLS) {
    const r = await packOne(out, file, entries, exclude);
    console.log(`packed ${r.file}  ${(r.bytes / 1000).toFixed(0)} kB  sha256 ${r.digest.slice(0, 16)}…`);
  }
  const tarball = path.join(out, 'attest-sign.tar.gz');
  /*
   * Rooted at the repository, not at `packages/`.
   *
   * The Dockerfile copies `packages/attest-sign/src`, so an archive that
   * extracted to a bare `attest-sign/` could not build the image it
   * contained — the documented `docker build` command failed on the very
   * download the page offered. Keeping the repo-relative prefix means the
   * published build command works from an extracted tarball exactly as it
   * does from a clone.
   *
   * The `node_modules` symlink is included so `node packages/attest-sign/src/cli.ts`
   * runs straight from the extraction with no install step, which is the
   * whole promise of a zero-dependency package.
   */
  execFileSync('tar', [
    '--sort=name', '--mtime=UTC 2020-01-01', '--owner=0', '--group=0', '--numeric-owner',
    '-czf', tarball,
    '-C', REPO,
    'packages/attest-sign/src', 'packages/attest-sign/package.json',
    'packages/attest-sign/Dockerfile',
    'packages/attest-sign/node_modules/@stonehash/attest-verify',
    'packages/attest-verify/src', 'packages/attest-verify/package.json',
  ]);
  const digest = createHash('sha256').update(await readFile(tarball)).digest('hex');
  await writeFile(path.join(out, 'attest-sign.sha256'), `${digest}  attest-sign.tar.gz\n`);
  return { bytes: (await stat(tarball)).size, digest };
}

async function build() {
  await assertReleases();
  await rm(DIST, { recursive: true, force: true });

  // `pnpm run` puts the workspace bins on PATH; a bare `node build.mjs` does
  // not, and the resulting ENOENT names `tsc` without saying why it vanished.
  // Adding the bin directories here makes both invocations work.
  const BIN = [
    path.join(HERE, 'node_modules/.bin'),
    path.join(REPO, 'node_modules/.bin'),
  ].join(path.delimiter);

  execFileSync(
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
    ['--project', 'tsconfig.build.json'],
    { cwd: HERE, stdio: 'inherit', env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ''}` } },
  );

  // The page itself, then the documents it fetches.
  await cp(path.join(HERE, 'public'), DIST, { recursive: true });
  await cp(path.join(HERE, 'content'), path.join(DIST, 'content'), { recursive: true });

  // The reference is data, read at runtime rather than compiled in, so the
  // drift test and the page are looking at the same bytes.
  await cp(path.join(HERE, 'openapi.json'), path.join(DIST, 'openapi.json'));

  for (const { from, to, why } of IMPORTED) {
    const target = path.join(DIST, to);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(from, target);
    console.log(`imported ${path.relative(REPO, from)} → ${to}  (${why})`);
  }

  /*
   * The signing SDK, packed and checksummed, with the download block written
   * into the page from the artefact that was actually produced. Hardcoding a
   * size or a digest in the markdown is how a published checksum ends up
   * describing a different file than the one beside it.
   */
  const sdk = await packSdk();
  const kb = (sdk.bytes / 1000).toFixed(0);
  // Both language copies carry the marker; both get the real figures. A
  // hardcoded size in one of them is how a published checksum ends up
  // describing a different file than the one beside it.
  // Two languages, one table. The npm row says "not yet" rather than naming
  // an install command that would 404 — the same rule the SDK page follows.
  for (const [signingPage, ko] of [
    [path.join(DIST, 'content/signing.md'), false],
    [path.join(DIST, 'content/ko/signing.md'), true],
  ]) {
  await writeFile(signingPage, (await readFile(signingPage, 'utf8')).replace(
    '<!-- DOWNLOADS -->',
    `| | |\n|---|---|\n`
    + `| **${ko ? '소스' : 'Source'}** | [attest-sign.tar.gz](./download/attest-sign.tar.gz) · ${kb} KB `
    + `· [sha256](./download/attest-sign.sha256) |\n`
    + `| **npm** | ${ko ? '아직 미공개 — 위 tarball을 사용하십시오' : 'not published yet — use the tarball above'} |\n\n`
    + `\`\`\`\n${sdk.digest}  attest-sign.tar.gz\n\`\`\``));
  }
  console.log(`packed attest-sign.tar.gz  ${kb} KB  sha256 ${sdk.digest.slice(0, 16)}…`);

  const files = await readdir(DIST, { recursive: true });
  const emitted = files.filter((f) => !f.endsWith(path.sep));

  // The page loads `./app.js` as a module. If `tsc` emitted nothing, every
  // other check here would still pass and the site would be a blank page.
  const entry = path.join(DIST, 'app.js');
  const entryStat = await stat(entry).catch(() => null);
  if (!entryStat?.isFile()) throw new Error('dist/app.js was not emitted — the page would be blank');

  // A `.ts` specifier surviving into the emitted JavaScript is the one failure
  // mode of building without a bundler, and the browser reports it only as a
  // blank panel. Checked here as well as in test/dist.test.ts so a bad build
  // fails at build time rather than at test time.
  for (const f of emitted.filter((x) => x.endsWith('.js'))) {
    const body = await readFile(path.join(DIST, f), 'utf8');
    for (const m of body.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
      if (m[1].endsWith('.ts')) throw new Error(`${f}: emitted a .ts specifier (${m[1]})`);
    }
  }

  console.log(`built ${emitted.length} files → ${path.relative(process.cwd(), DIST)}`);
}

await build().catch((e) => { console.error(e); process.exit(1); });
