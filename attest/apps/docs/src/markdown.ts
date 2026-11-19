/**
 * A small Markdown renderer, for the documents this hub publishes.
 *
 * ## Why not a library
 *
 * The Developer Hub ships under `default-src 'none'; script-src 'self'` and is
 * meant to keep working with the network off, so a CDN renderer is not an
 * option. Installing one instead would put a transitive dependency tree in
 * front of the Evidence Specification — the one document a regulator is here to
 * read — and the whole argument for publishing that specification is that it
 * can be checked without trusting our toolchain.
 *
 * So this handles the subset the published documents actually use. It is not a
 * general CommonMark implementation and does not pretend to be: the inputs are
 * files in this repository, and `test/content.test.ts` renders every one of
 * them and asserts the output is sane.
 *
 * ## Escaping
 *
 * Everything is escaped before any markup is emitted, and the only HTML that
 * reaches the output is HTML this file wrote. `bundle-schema.md` is full of
 * JSON with angle brackets and quotes, so this is load-bearing for correctness
 * and not merely a precaution against a hostile input we do not have.
 */

/** Escape for text and attribute contexts alike. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A heading's `id`, so the page can be deep-linked section by section. */
export function slug(text: string): string {
  return text.toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

/**
 * Sentinel for extracted code spans.
 *
 * A printable placeholder cannot be used here. The first version marked slots
 * as `" 0 "`, and `bundle-schema.md` contains byte-offset tables with bare
 * numbers surrounded by spaces — so reinsertion replaced the wrong text and
 * silently corrupted the specification's layout tables. U+0000 cannot occur in
 * the source documents.
 */
const SLOT = '\u0000';

/**
 * Inline spans: code, bold, italic, links.
 *
 * Code is extracted first and reinserted last. Without that, a span like
 * `` `**not bold**` `` renders as bold inside a code sample — which in a
 * specification is not cosmetic, because the asterisks are part of the bytes
 * being documented.
 */
function inline(src: string): string {
  const code: string[] = [];
  let s = src.replace(/`([^`]+)`/g, (_m, c: string) => {
    code.push(`<code>${esc(c)}</code>`);
    return `${SLOT}${code.length - 1}${SLOT}`;
  });

  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    // Relative, same-document and explicit http(s) targets only. Anything else
    // — `javascript:`, `data:` — is dropped rather than rewritten, so a bad
    // link in a document becomes visibly inert instead of quietly dangerous.
    const safe = /^(https?:\/\/|#|\.|\/)/.test(href) ? href : '#';
    const ext = /^https?:\/\//.test(safe);
    return `<a href="${safe}"${ext ? ' rel="noopener noreferrer" target="_blank"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return s.replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, 'g'), (_m, i: string) => code[Number(i)]!);
}

export interface Heading { depth: number; id: string; text: string }

/** Rendered HTML plus the headings, which the page turns into a contents rail. */
export interface Rendered { html: string; headings: Heading[] }

export function renderMarkdown(src: string): Rendered {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  let i = 0;

  const seen = new Map<string, number>();
  const uniqueId = (text: string): string => {
    const base = slug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code. The info string becomes a class so `jsonc` and `bash` can be
    // styled, but nothing in it is executed or interpreted.
    const fence = /^```+\s*(\S*)/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence
      out.push(`<pre class="code${lang ? ` lang-${esc(lang)}` : ''}"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      const depth = head[1]!.length;
      const text = head[2]!.replace(/\s*#+\s*$/, '');
      const id = uniqueId(text);
      headings.push({ depth, id, text: text.replace(/[`*]/g, '') });
      out.push(`<h${depth} id="${esc(id)}">${inline(text)}</h${depth}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // Tables: a header row, a delimiter row, then body rows — the only form the
    // published documents use.
    if (line.includes('|') && i + 1 < lines.length
      && /^[\s|:-]+$/.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const cells = (row: string): string[] =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const align = cells(lines[i + 1]!).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
      const header = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') body.push(cells(lines[i++]!));
      // A class, not a `style` attribute: the hub ships under
      // `style-src 'self'`, which blocks inline styles outright — so the
      // alignment a table asked for was being silently dropped.
      const cls = (n: number): string => (align[n] ? ` class="ta-${align[n]}"` : '');
      const th = header.map((c, n) => `<th${cls(n)}>${inline(c)}</th>`).join('');
      const tr = body.map((r) =>
        `<tr>${r.map((c, n) => `<td${cls(n)}>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n')).html}</blockquote>`);
      continue;
    }

    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (!m) {
          // A wrapped continuation line belongs to the item above it.
          if (items.length > 0 && /^\s+\S/.test(lines[i]!)) {
            items[items.length - 1] += ` ${inline(lines[i]!.trim())}`;
            i++;
            continue;
          }
          break;
        }
        items.push(inline(m[3]!));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${t}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== ''
      && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+\.)\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return { html: out.join('\n'), headings };
}
