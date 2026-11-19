/**
 * A small XML reader — exactly enough to read ISO 20022 payment messages,
 * and deliberately no more.
 *
 * Why not a library: this SDK ships as source a bank can read end to end,
 * with no third-party dependency to audit. Why not the platform's parser:
 * there is none — the platform never sees the bank's message, only the
 * instruction this package derives from it.
 *
 * What it refuses, on purpose:
 *   - a document type declaration (`<!DOCTYPE …>`), and with it every
 *     entity trick — external entities, parameter entities, entity
 *     expansion. A payment message has no use for a DTD; a parser that
 *     honours one can be made to read files or exhaust memory.
 *   - any entity other than the five XML predefines and numeric character
 *     references.
 *   - input over 4 MiB, nested deeper than 64 elements, or with more than 64
 *     namespace prefixes in scope.
 *   - what is not well-formed and could be read two ways: an attribute
 *     written twice, a prefix that is not declared, a character XML does not
 *     allow.
 *
 * Namespaces are resolved (prefix → URI) because the message type lives in
 * the namespace URI, and because real messages arrive both with a default
 * namespace and with prefixes, bare or inside an envelope. Navigation is
 * namespace-aware for the same reason a bank's own validator is: an element
 * from another vocabulary slipped in beside `<Nm>` is not the name.
 */

export interface XmlElement {
  /** Local name, prefix removed. */
  name: string;
  /** Namespace URI in scope for this element ('' when none). */
  ns: string;
  /**
   * Unqualified attributes by name. An attribute with a prefix belongs to
   * another vocabulary (`xsi:schemaLocation` …) and is not kept; `xmlns`
   * declarations are not included.
   */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Character data directly inside this element, entity-decoded. */
  text: string;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
/** Real messages declare a handful; the cap keeps the cost of a scope bounded. */
const MAX_PREFIXES = 64;
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NO_SCOPE: ReadonlyMap<string, string> = new Map();
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
/**
 * The five entities XML predefines. A Map, not an object: the name comes from
 * the message, and `&valueOf;` must not find a method on Object.prototype.
 */
const PREDEFINED: ReadonlyMap<string, string> = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

function validCodePoint(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd
    || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd)
    || (cp >= 0x10000 && cp <= 0x10ffff);
}

function decodeEntities(raw: string, at: number): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&\s]{0,32});?/g, (whole, body: string) => {
    if (!whole.endsWith(';') || body === '') {
      throw new XmlError(`a bare "&" must be written &amp; (near offset ${at})`);
    }
    if (body.startsWith('#')) {
      // XML writes a hexadecimal reference `&#x…;` — never `&#X…;`.
      const hex = body[1] === 'x';
      const digits = body.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) {
        throw new XmlError(`malformed character reference &${body}; (near offset ${at})`);
      }
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!validCodePoint(cp)) throw new XmlError(`character reference &${body}; is not a legal XML character`);
      return String.fromCodePoint(cp);
    }
    const known = PREDEFINED.get(body);
    if (known === undefined) {
      throw new XmlError(`entity &${body}; is not defined — only &amp; &lt; &gt; &quot; &apos; and numeric references are accepted`);
    }
    return known;
  });
}

interface Open { el: XmlElement; qname: string; scope: ReadonlyMap<string, string> }

/** Parse one XML document and return its root element. */
export function parseXml(input: string): XmlElement {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (s.length > MAX_BYTES) throw new XmlError(`message is larger than ${MAX_BYTES} characters`);
  const illegal = ILLEGAL_CHAR.exec(s);
  if (illegal) {
    throw new XmlError(`character U+${illegal[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} `
      + `at offset ${illegal.index} is not allowed in XML`);
  }

  const n = s.length;
  const stack: Open[] = [];
  let root: XmlElement | null = null;
  let closed = false;
  let i = 0;

  const top = (): Open => stack[stack.length - 1]!;
  const fail = (msg: string): never => { throw new XmlError(`${msg} (offset ${i})`); };

  while (i < n) {
    const lt = s.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const raw = s.slice(i, textEnd);
      if (stack.length > 0) top().el.text += decodeEntities(raw, i);
      else if (raw.trim() !== '') fail('text outside the root element');
    }
    if (lt === -1) break;
    i = lt;

    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end === -1) fail('unterminated comment');
      i = end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end === -1) fail('unterminated CDATA section');
      if (stack.length === 0) fail('CDATA outside the root element');
      top().el.text += s.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i + 2);
      if (end === -1) fail('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (s.startsWith('<!', i)) {
      // Met where markup is read — not searched for in the whole text, where
      // the words may sit harmlessly inside a comment or a CDATA section.
      if (/^<!(DOCTYPE|ENTITY)/i.test(s.slice(i, i + 9))) {
        throw new XmlError('a document type declaration is refused — payment messages carry no DTD, and none is processed');
      }
      fail('markup declarations are refused');
    }

    if (s.startsWith('</', i)) {
      const end = s.indexOf('>', i + 2);
      if (end === -1) fail('unterminated closing tag');
      const qname = s.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open) { fail(`</${qname}> has no opening tag`); break; }
      if (open.qname !== qname) fail(`</${qname}> closes <${open.qname}>`);
      i = end + 1;
      if (stack.length === 0) closed = true;
      continue;
    }

    // A start tag. Find its end without being fooled by ">" inside a quoted value.
    let j = i + 1;
    let quote = '';
    for (; j < n; j++) {
      const c = s[j]!;
      if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
    }
    if (j >= n) fail('unterminated tag');
    let inner = s.slice(i + 1, j);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);

    const nameMatch = /^[^\s]+/.exec(inner);
    const qname = nameMatch ? nameMatch[0] : '';
    if (!NAME.test(qname)) fail(`"${qname.slice(0, 40)}" is not an element name`);
    if (closed) fail('a second root element');

    // The parent's scope is shared, not copied: only an element that declares
    // a namespace gets a map of its own. Copying per element made a message
    // with many prefixes quadratic.
    let scope: ReadonlyMap<string, string> = stack.length > 0 ? top().scope : NO_SCOPE;
    let declared: Map<string, string> | null = null;
    const attrs: Record<string, string> = {};
    const seen = new Set<string>();
    const prefixed: string[] = [];
    const attrRe = /\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
    attrRe.lastIndex = qname.length;
    let consumed = qname.length;
    for (let m = attrRe.exec(inner); m; m = attrRe.exec(inner)) {
      const key = m[1]!;
      const value = decodeEntities(m[2] ?? m[3] ?? '', i);
      if (!NAME.test(key)) fail(`"${key.slice(0, 40)}" is not an attribute name`);
      if (seen.has(key)) fail(`attribute ${key} is written twice in <${qname}>`);
      seen.add(key);
      if (key === 'xmlns' || key.startsWith('xmlns:')) {
        declared ??= new Map(scope);
        declared.set(key === 'xmlns' ? '' : key.slice(6), value);
        if (declared.size > MAX_PREFIXES) fail(`more than ${MAX_PREFIXES} namespace prefixes in scope`);
        scope = declared;
      } else if (key.includes(':')) {
        prefixed.push(key.slice(0, key.indexOf(':')));
      } else {
        attrs[key] = value;
      }
      consumed = attrRe.lastIndex;
    }
    if (inner.slice(consumed).trim() !== '') fail(`malformed attributes in <${qname}>`);
    for (const pfx of prefixed) {
      if (pfx !== 'xml' && !scope.has(pfx)) fail(`namespace prefix "${pfx}" is not declared`);
    }

    const colon = qname.indexOf(':');
    const prefix = colon === -1 ? '' : qname.slice(0, colon);
    if (prefix !== '' && !scope.has(prefix)) fail(`namespace prefix "${prefix}" is not declared`);
    const el: XmlElement = {
      name: colon === -1 ? qname : qname.slice(colon + 1),
      ns: scope.get(prefix) ?? '',
      attrs,
      children: [],
      text: '',
    };
    if (stack.length > 0) top().el.children.push(el);
    else root = el;

    if (selfClosing) {
      if (stack.length === 0) closed = true;
    } else {
      if (stack.length >= MAX_DEPTH) fail(`elements nested deeper than ${MAX_DEPTH}`);
      stack.push({ el, qname, scope });
    }
    i = j + 1;
  }

  if (stack.length > 0) throw new XmlError(`<${top().qname}> is never closed`);
  if (!root) throw new XmlError('no XML element found');
  return root;
}

// ── Navigation helpers ─────────────────────────────────────────────────────

/**
 * The one direct child with this name, in the parent's own namespace.
 *
 * For elements the message carries at most once. Two of them is a message
 * that can be read two ways — which name, which amount — and is refused
 * rather than settled by taking the first.
 */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!el) return undefined;
  let hit: XmlElement | undefined;
  for (const c of el.children) {
    if (c.name !== name || c.ns !== el.ns) continue;
    if (hit) throw new XmlError(`<${name}> occurs more than once inside <${el.name}> — one is expected`);
    hit = c;
  }
  return hit;
}

/** Every direct child with this name, in the parent's own namespace — for elements that may repeat. */
export function childrenOf(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name && c.ns === el.ns) : [];
}

/** Follow a `A/B/C` path of direct children, each expected once. */
export function at(el: XmlElement | undefined, path: string): XmlElement | undefined {
  let cur = el;
  for (const step of path.split('/')) {
    if (!cur) return undefined;
    cur = child(cur, step);
  }
  return cur;
}

/** Trimmed text at a path, or undefined when the element is absent or empty. */
export function textAt(el: XmlElement | undefined, path: string): string | undefined {
  const hit = path === '' ? el : at(el, path);
  const t = hit?.text.trim();
  return t ? t : undefined;
}

/** Depth-first search for the first element with this local name. */
export function findFirst(el: XmlElement, name: string): XmlElement | undefined {
  if (el.name === name) return el;
  for (const c of el.children) {
    const hit = findFirst(c, name);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Escape character data for an XML text node or attribute value. Characters
 * XML 1.0 does not allow at all (control characters other than tab, line
 * feed and carriage return) are dropped — text that came from another
 * system's event must not be able to make the report unreadable.
 */
export function xmlEscape(text: string): string {
  // eslint-disable-next-line no-control-regex
  // A half surrogate cannot be written in UTF-8 at all: dropped, like the characters XML 1.0 forbids.
  return text.replace(/\p{Cs}/gu, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'
  ));
}
