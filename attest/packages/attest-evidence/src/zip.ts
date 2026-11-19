/**
 * A ZIP writer, with no third-party dependency.
 *
 * ## Why hand-rolled
 *
 * The evidence bundle has to be produced both by the service and by the
 * Playground in a browser, and the whole product rests on a customer being able
 * to audit what they were given. An archiver pulled from npm would add a
 * transitive tree to that audit for a format that is, for our purposes, a
 * handful of fixed-layout headers. Real DEFLATE comes from the platform:
 * `CompressionStream('deflate-raw')` is built into Node 18+ and every current
 * browser, so compression is neither hand-written nor imported.
 *
 * ## Reproducibility
 *
 * A reviewer who re-exports the same evidence must get the same bytes, so a
 * digest of the archive means something. ZIP stores a modification time per
 * entry, so the timestamp is **taken from the caller**, never from the clock.
 * `writeZip` reads no clock, no locale and no environment.
 *
 * Only what the format requires is emitted: local headers, central directory,
 * end-of-central-directory. No Zip64 (an evidence bundle is kilobytes), no
 * encryption, no data descriptors.
 */

/** CRC-32, as ZIP specifies it. */
const CRC_TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive. Forward slashes, no leading slash. */
  path: string;
  data: Uint8Array;
}

export interface ZipOptions {
  /**
   * Modification time written into every entry.
   *
   * Required, and deliberately so: defaulting to the current time would make
   * two exports of identical evidence differ, and a digest of the archive
   * would then prove nothing.
   */
  modifiedAt: Date;
  /** `false` stores entries uncompressed — useful when a reader lacks inflate. */
  compress?: boolean;
}

/** DOS date/time, as ZIP has encoded it since 1989. Second resolution is 2s. */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = d.getUTCFullYear();
  if (year < 1980) throw new Error(`ZIP cannot represent a date before 1980, got ${d.toISOString()}`);
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
  };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  // `Uint8Array` is generic over its backing buffer in current TypeScript, and
  // the stream signature wants a concrete `BufferSource`. Taking the view's own
  // buffer slice gives one without copying the caller's array.
  const view: BufferSource = data.buffer instanceof ArrayBuffer
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  void writer.write(view);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

class Buf {
  private parts: Uint8Array[] = [];
  private len = 0;
  get length(): number { return this.len; }
  push(b: Uint8Array): void { this.parts.push(b); this.len += b.length; }
  u16(n: number): void { this.push(new Uint8Array([n & 0xff, (n >>> 8) & 0xff])); }
  u32(n: number): void {
    this.push(new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]));
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/**
 * Build a ZIP archive.
 *
 * Entries keep the order given, which keeps the output a pure function of the
 * input — the manifest lists them in the same order a reader encounters them.
 */
export async function writeZip(entries: ZipEntry[], opts: ZipOptions): Promise<Uint8Array> {
  if (entries.length === 0) throw new Error('writeZip: an archive needs at least one entry');
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.path.startsWith('/') || e.path.includes('..')) {
      throw new Error(`writeZip: unsafe entry path ${JSON.stringify(e.path)}`);
    }
    if (seen.has(e.path)) throw new Error(`writeZip: duplicate entry ${e.path}`);
    seen.add(e.path);
  }

  const { date, time } = dosDateTime(opts.modifiedAt);
  const compress = opts.compress !== false;
  const enc = new TextEncoder();
  const body = new Buf();
  const central = new Buf();

  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.data);
    const stored = compress ? await deflateRaw(e.data) : e.data;
    // Deflate can exceed the input on incompressible or tiny data; storing is
    // then both smaller and faster to read.
    const useDeflate = compress && stored.length < e.data.length;
    const payload = useDeflate ? stored : e.data;
    const method = useDeflate ? 8 : 0;
    const offset = body.length;

    body.u32(0x04034b50);           // local file header
    body.u16(useDeflate ? 20 : 10); // version needed
    body.u16(0x0800);               // flags: UTF-8 names
    body.u16(method);
    body.u16(time); body.u16(date);
    body.u32(crc);
    body.u32(payload.length);
    body.u32(e.data.length);
    body.u16(name.length);
    body.u16(0);                    // extra field length
    body.push(name);
    body.push(payload);

    central.u32(0x02014b50);        // central directory header
    central.u16(0x031e);            // made by: UNIX, spec 3.0
    central.u16(useDeflate ? 20 : 10);
    central.u16(0x0800);
    central.u16(method);
    central.u16(time); central.u16(date);
    central.u32(crc);
    central.u32(payload.length);
    central.u32(e.data.length);
    central.u16(name.length);
    central.u16(0); central.u16(0); // extra, comment
    central.u16(0);                 // disk number
    central.u16(0);                 // internal attributes
    central.u32(0o100644 << 16);    // external attributes: regular file, rw-r--r--
    central.u32(offset);
    central.push(name);
  }

  const out = new Buf();
  out.push(body.concat());
  const centralOffset = out.length;
  out.push(central.concat());
  out.u32(0x06054b50);              // end of central directory
  out.u16(0); out.u16(0);           // this disk, disk with central directory
  out.u16(entries.length); out.u16(entries.length);
  out.u32(central.length);
  out.u32(centralOffset);
  out.u16(0);                       // archive comment length
  return out.concat();
}
