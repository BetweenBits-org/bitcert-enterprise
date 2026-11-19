/**
 * The archive has to open in whatever the reviewer already has, so these tests
 * check it against the system `unzip` rather than against our own reader —
 * a writer validated only by its matching parser can be self-consistently wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, writeZip } from '../src/zip.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const AT = new Date('2026-03-04T09:02:00Z');

function withZip<T>(bytes: Uint8Array, fn: (file: string, dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'zip-'));
  try {
    const file = path.join(dir, 'a.zip');
    writeFileSync(file, bytes);
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CRC-32 matches the published check value', () => {
  // The standard "123456789" vector for CRC-32/ISO-HDLC.
  assert.equal(crc32(utf8('123456789')).toString(16), 'cbf43926');
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('the system unzip accepts the archive and reports no errors', () => {
  const zip = writeZip([
    { path: 'manifest.json', data: utf8(JSON.stringify({ a: 1 })) },
    { path: 'nested/report.txt', data: utf8('x'.repeat(4000)) },
  ], { modifiedAt: AT });
  return zip.then((bytes) => withZip(bytes, (file) => {
    const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.match(out, /No errors detected/);
  }));
});

test('extracted contents are byte-identical, compressed and stored alike', async () => {
  const big = utf8(JSON.stringify({ padding: 'y'.repeat(5000) })); // compresses well
  const tiny = utf8('no');                                          // will not
  const zip = await writeZip([
    { path: 'big.json', data: big },
    { path: 'tiny.txt', data: tiny },
  ], { modifiedAt: AT });

  withZip(zip, (file, dir) => {
    execFileSync('unzip', ['-q', file, '-d', dir]);
    assert.deepEqual(new Uint8Array(readFileSync(path.join(dir, 'big.json'))), big);
    assert.deepEqual(new Uint8Array(readFileSync(path.join(dir, 'tiny.txt'))), tiny);
    // The compressible member must actually have been deflated, and the
    // incompressible one stored rather than grown.
    const info = execFileSync('zipinfo', ['-v', file], { encoding: 'utf8' });
    assert.match(info, /big\.json[\s\S]*?compression method:\s+deflated/i);
    // zipinfo prints "none (stored)" for method 0.
    assert.match(info, /tiny\.txt[\s\S]*?compression method:\s+none \(stored\)/i);
  });
});

test('the same input produces byte-identical archives', async () => {
  const entries = [{ path: 'a.json', data: utf8('{"k":1}') }];
  const a = await writeZip(entries, { modifiedAt: AT });
  const b = await writeZip(entries, { modifiedAt: AT });
  assert.deepEqual(a, b);
  // A different timestamp must change the bytes — it is recorded, not ignored.
  const c = await writeZip(entries, { modifiedAt: new Date('2026-03-05T09:02:00Z') });
  assert.notDeepEqual(a, c);
});

test('compress: false stores everything, for a reader without inflate', async () => {
  const data = utf8(JSON.stringify({ padding: 'z'.repeat(5000) }));
  const zip = await writeZip([{ path: 'a.json', data }], { modifiedAt: AT, compress: false });
  assert.ok(zip.length > data.length, 'stored output must be at least the input size');
  withZip(zip, (file, dir) => {
    execFileSync('unzip', ['-q', file, '-d', dir]);
    assert.deepEqual(new Uint8Array(readFileSync(path.join(dir, 'a.json'))), data);
  });
});

test('unsafe and duplicate paths are refused', async () => {
  await assert.rejects(() => writeZip([{ path: '/etc/passwd', data: utf8('x') }], { modifiedAt: AT }),
    /unsafe entry path/);
  await assert.rejects(() => writeZip([{ path: '../escape', data: utf8('x') }], { modifiedAt: AT }),
    /unsafe entry path/);
  await assert.rejects(() => writeZip(
    [{ path: 'a', data: utf8('1') }, { path: 'a', data: utf8('2') }], { modifiedAt: AT }),
    /duplicate entry/);
  await assert.rejects(() => writeZip([], { modifiedAt: AT }), /at least one entry/);
});

test('dates before 1980 are refused rather than silently wrapped', async () => {
  await assert.rejects(
    () => writeZip([{ path: 'a', data: utf8('x') }], { modifiedAt: new Date('1979-01-01T00:00:00Z') }),
    /before 1980/);
});

test('non-ASCII entry names survive the round trip', async () => {
  const zip = await writeZip([{ path: '증거/보고서.json', data: utf8('{"ko":true}') }],
    { modifiedAt: AT });
  withZip(zip, (file) => {
    const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.match(out, /No errors detected/);
  });
});
