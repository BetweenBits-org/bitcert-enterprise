/**
 * A minimal PDF writer — text only, no dependency.
 *
 * ## Why hand-rolled
 *
 * The verification report is what a reviewer files, so it has to be a PDF and it
 * has to be producible in a browser as well as on the server. A PDF library is
 * a large dependency for what this report needs: paragraphs, a few tables of
 * key/value rows, and monospace digests. PDF 1.4 with the standard Type 1 fonts
 * is a text format with an index at the end, so that much is a few hundred
 * lines and is entirely auditable.
 *
 * ## The real limitation: this report is English only
 *
 * The 14 standard PDF fonts are single-byte and cover Latin-1. Rendering Korean
 * would require embedding a CJK font — a megabyte or more of font programme plus
 * CID mapping, which would dwarf the rest of this repository and ship a binary
 * blob into an artefact whose selling point is auditability.
 *
 * So the printable report is English, and non-Latin-1 characters are
 * transliterated or dropped rather than silently emitting mojibake. Every value
 * a reviewer needs to act on — amounts, references, digests, axis states, policy
 * version — is ASCII anyway, and `evidence.json` and `matching-results.json`
 * inside the same archive carry the full text in whatever language it was
 * supplied. The PDF is the summary, not the record.
 *
 * ## Reproducibility
 *
 * No clock. `CreationDate` comes from the caller, so re-exporting the same
 * evidence yields the same bytes.
 */

export type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Courier';

export interface TextRun {
  text: string;
  font?: FontName;
  size?: number;
  /** Extra space above this line, in points. */
  spaceBefore?: number;
  /** Draw a hairline rule below the line. */
  rule?: boolean;
  /** Indent from the left margin, in points. */
  indent?: number;
}

const PAGE = { width: 595.28, height: 841.89 }; // A4 in points
const MARGIN = { left: 56, right: 56, top: 64, bottom: 64 };
const LEADING = 1.45;

/** Widths per 1000 units for the subset of Helvetica we need, for wrapping. */
const HELV_WIDTH: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333, '{': 334, '|': 260,
  '}': 334, '~': 584,
};
for (const c of '0123456789') HELV_WIDTH[c] = 556;
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') HELV_WIDTH[c] = 'IJ'.includes(c) ? 278 : 'MW'.includes(c) ? 889 : 667;
for (const c of 'abcdefghijklmnopqrstuvwxyz') HELV_WIDTH[c] = 'ijlt'.includes(c) ? 250 : 'mw'.includes(c) ? 833 : 556;

/** Approximate string width in points. Courier is fixed-pitch at 600/1000. */
function textWidth(s: string, font: FontName, size: number): number {
  if (font === 'Courier') return (s.length * 600 * size) / 1000;
  let w = 0;
  for (const ch of s) w += HELV_WIDTH[ch] ?? 556;
  // Bold is wider; 1.06 is close enough for wrapping decisions.
  return (w * size * (font === 'Helvetica-Bold' ? 1.06 : 1)) / 1000;
}

/**
 * Reduce text to what a standard PDF font can render.
 *
 * Common typographic punctuation is mapped to its ASCII equivalent; anything
 * still outside Latin-1 becomes `?`. Dropping silently would make a report look
 * complete while missing words, which is worse than a visible placeholder.
 */
export function toLatin1(s: string): string {
  const map: Record<string, string> = {
    '‘': "'", '’': "'", '“': '"', '”': '"',
    '–': '-', '—': '--', '…': '...', ' ': ' ',
    '→': '->', '←': '<-', '↑': '^', '↓': 'v',
    '✓': 'OK', '✗': 'X', '·': '-', '•': '*',
    '①': '(1)', '②': '(2)', '③': '(3)',
    '④': '(4)', '⑤': '(5)', '⑥': '(6)',
  };
  let out = '';
  for (const ch of s) {
    const mapped = map[ch];
    if (mapped !== undefined) { out += mapped; continue; }
    const code = ch.codePointAt(0)!;
    out += code <= 0xff ? ch : '?';
  }
  return out;
}

/** Escape for a PDF literal string. */
function pdfString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Wrap a run to the content width, returning one entry per output line. */
function wrap(run: TextRun, width: number): string[] {
  const font = run.font ?? 'Helvetica';
  const size = run.size ?? 10;
  const text = toLatin1(run.text);
  if (textWidth(text, font, size) <= width) return [text];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, font, size) <= width) { line = next; continue; }
    if (line) out.push(line);
    // A single token longer than the line — a digest — is split by character.
    if (textWidth(word, font, size) > width) {
      let chunk = '';
      for (const ch of word) {
        if (textWidth(chunk + ch, font, size) > width) { out.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    } else line = word;
  }
  if (line) out.push(line);
  return out;
}

export interface PdfOptions {
  title: string;
  /** Written as `CreationDate`. Supplied, never read from the clock. */
  createdAt: Date;
  /** Appears at the foot of every page. */
  footer?: string;
}

/** Render runs into a PDF document. */
export function renderPdf(runs: TextRun[], opts: PdfOptions): Uint8Array {
  const contentWidth = PAGE.width - MARGIN.left - MARGIN.right;

  interface Line { text: string; font: FontName; size: number; y: number; rule: boolean; x: number }
  const pages: Line[][] = [];
  let page: Line[] = [];
  let y = PAGE.height - MARGIN.top;

  for (const run of runs) {
    const font = run.font ?? 'Helvetica';
    const size = run.size ?? 10;
    const indent = run.indent ?? 0;
    y -= run.spaceBefore ?? 0;
    for (const text of wrap(run, contentWidth - indent)) {
      if (y < MARGIN.bottom + size) { pages.push(page); page = []; y = PAGE.height - MARGIN.top; }
      y -= size * LEADING;
      page.push({ text, font, size, y, rule: false, x: MARGIN.left + indent });
    }
    if (run.rule && page.length > 0) page[page.length - 1]!.rule = true;
  }
  pages.push(page);

  const enc = new TextEncoder();
  const objects: string[] = [];
  const add = (body: string): number => { objects.push(body); return objects.length; };

  // Fonts 1-3, catalog/pages/page objects follow.
  const fontIds: Record<FontName, number> = {
    Helvetica: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    'Helvetica-Bold': add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
    Courier: add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
  };

  const pageObjIds: number[] = [];
  const contentIds: number[] = [];
  for (const [i, lines] of pages.entries()) {
    const ops: string[] = [];
    for (const l of lines) {
      ops.push('BT', `/F${fontIds[l.font]} ${l.size} Tf`,
        `1 0 0 1 ${l.x.toFixed(2)} ${l.y.toFixed(2)} Tm`,
        `(${pdfString(l.text)}) Tj`, 'ET');
      if (l.rule) {
        ops.push('0.85 0.85 0.85 RG 0.5 w',
          `${MARGIN.left} ${(l.y - 5).toFixed(2)} m ${(PAGE.width - MARGIN.right).toFixed(2)} ${(l.y - 5).toFixed(2)} l S`);
      }
    }
    const foot = opts.footer ? `${toLatin1(opts.footer)}  ·  page ${i + 1} of ${pages.length}` : `page ${i + 1} of ${pages.length}`;
    ops.push('BT', `/F${fontIds.Helvetica} 7.5 Tf`, '0.45 0.45 0.45 rg',
      `1 0 0 1 ${MARGIN.left} ${(MARGIN.bottom - 24).toFixed(2)} Tm`,
      `(${pdfString(toLatin1(foot))}) Tj`, 'ET', '0 0 0 rg');
    const stream = ops.join('\n');
    contentIds.push(add(`<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream`));
    pageObjIds.push(0); // placeholder, filled below
  }

  const pagesId = objects.length + pages.length + 1;
  for (const [i] of pages.entries()) {
    pageObjIds[i] = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] `
      + `/Resources << /Font << /F${fontIds.Helvetica} ${fontIds.Helvetica} 0 R `
      + `/F${fontIds['Helvetica-Bold']} ${fontIds['Helvetica-Bold']} 0 R `
      + `/F${fontIds.Courier} ${fontIds.Courier} 0 R >> >> `
      + `/Contents ${contentIds[i]} 0 R >>`);
  }
  const realPagesId = add(
    `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  // Page objects referenced the id this object would take; assert it held.
  if (realPagesId !== pagesId) {
    throw new Error(`pdf: page tree id drifted (${realPagesId} vs predicted ${pagesId})`);
  }
  const iso = opts.createdAt.toISOString();
  const d = `D:${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`
    + `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  const infoId = add(`<< /Title (${pdfString(toLatin1(opts.title))}) /Producer (StoneHash Attest) `
    + `/Creator (StoneHash Attest) /CreationDate (${d}) /ModDate (${d}) >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  // Serialise with a cross-reference table.
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n`
    + `startxref\n${xref}\n%%EOF\n`;

  return latin1Bytes(pdf);
}

/** Byte length of a Latin-1 serialisation — one byte per code unit. */
function byteLength(s: string): number {
  return s.length;
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
