/**
 * One entry point for the three message families.
 *
 * The caller hands over the message exactly as the bank's system wrote it —
 * a string, or the bytes of the file — and gets the payment(s) inside. The
 * SHA-256 recorded on each payment is over those exact bytes, so
 * `sha256sum message.xml` on the bank's side reproduces the value that
 * later appears, signed, in the settlement evidence.
 *
 * A file may hold more than one payment: a pacs.008 or pain.001 with several
 * transactions, a wrapper around several documents, several MT103 one after
 * another. Every one of them is returned, in order — a file is never read as
 * "the first payment in it".
 */
import { createHash } from 'node:crypto';
import { looksLikeXml, parseIso20022 } from './iso20022.ts';
import { looksLikeMt, parseMt103 } from './mt103.ts';
import { ownReference } from './mapping.ts';
import { SwiftMessageError } from './model.ts';
import type { SwiftPayment } from './model.ts';

const utf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
/** Each byte as the code point of the same number. */
const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

/**
 * The encodings an XML message may declare, with every label each goes by.
 * A label is matched as WHATWG matches it — ASCII letters in either case, the
 * white space around it ignored — and any other label refuses the message.
 * The single-byte ones are decoded here, not by the platform: what its decoder
 * makes of them depends on how Node was built (windows-1252 itself came out
 * as Latin-1, and US-ASCII let any byte through), and the same message must
 * read the same everywhere, in every language this reader is ported to.
 *
 *   utf-8, utf-16le, utf-16be   the platform's strict decoder
 *   iso-8859-1                  each byte is the code point of the same number
 *   us-ascii                    the same, and a byte above 0x7F refuses the message
 *   windows-1252                the code page itself: 0x80–0x9F by the table below
 */
type XmlEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'iso-8859-1' | 'us-ascii' | 'windows-1252';
const XML_ENCODING_LABELS: Readonly<Record<XmlEncoding, readonly string[]>> = {
  'utf-8': ['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8'],
  'utf-16le': ['utf-16', 'utf-16le', 'ucs-2', 'unicode', 'csunicode', 'iso-10646-ucs-2', 'unicodefeff'],
  'utf-16be': ['utf-16be', 'unicodefffe'],
  'iso-8859-1': ['iso-8859-1', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'iso-ir-100', 'csisolatin1',
    'latin1', 'l1', 'cp819', 'ibm819'],
  'us-ascii': ['us-ascii', 'ascii', 'ansi_x3.4-1968'],
  'windows-1252': ['windows-1252', 'cp1252', 'x-cp1252'],
};
/** Label (lower case) → encoding. A Map: the label comes from the message. */
const XML_ENCODING_OF: ReadonlyMap<string, XmlEncoding> = new Map((Object.keys(XML_ENCODING_LABELS) as XmlEncoding[])
  .flatMap((encoding) => XML_ENCODING_LABELS[encoding].map((label) => [label, encoding] as const)));

/**
 * windows-1252 bytes 0x80–0x9F, from the WHATWG index; every other byte is
 * the code point of the same number. The five the code page leaves
 * unassigned — 0x81, 0x8D, 0x8F, 0x90, 0x9D — stay U+0081 … as WHATWG has them.
 */
const WINDOWS_1252_80_9F: readonly number[] = [
  /* 0x80 */ 0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  /* 0x88 */ 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  /* 0x90 */ 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  /* 0x98 */ 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];
const WINDOWS_1252_80_9F_CHARS = WINDOWS_1252_80_9F.map((cp) => String.fromCharCode(cp));

/** Bytes that are not valid in the encoding the message is read in. */
const notValidIn = (how: string): SwiftMessageError => new SwiftMessageError('malformed_message',
  `the message ${how} but holds bytes that are not valid in it — `
  + 'it was written in another code page; export it as UTF-8, or declare the encoding it is really in');

/**
 * The bytes of an XML message as text, in the encoding the message itself
 * declares (UTF-8 when it declares none). Bytes that are not valid in that
 * encoding refuse the message: guessing another code page would turn a
 * company's name into different characters and carry them, unremarked, into
 * the Travel Rule data.
 */
function decodeXml(bytes: Uint8Array): string {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  if (utf16) {
    try {
      return new TextDecoder(utf16, { fatal: true }).decode(bytes);
    } catch {
      throw new SwiftMessageError('malformed_message',
        'the message starts with a UTF-16 byte-order mark but holds bytes that are not valid UTF-16 — the file is cut off or damaged');
    }
  }
  // The declaration is ASCII in every encoding this reader takes. The label is
  // taken whole, up to its closing quote: one the reader cannot match is
  // refused, never passed over for the default.
  const head = latin1(bytes.subarray(0, 200));
  const m = /^(?:\xEF\xBB\xBF)?\s*<\?xml[^>]*?\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(head);
  const declared = m ? (m[1] ?? m[2])! : 'UTF-8';
  const name = declared.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  const encoding = XML_ENCODING_OF.get(name.replace(/[A-Z]/g, (c) => c.toLowerCase()));
  if (!encoding) {
    throw new SwiftMessageError('malformed_message',
      `the message declares encoding "${declared}", which this reader does not know — send it as UTF-8`);
  }
  if (encoding === 'utf-8' || encoding === 'utf-16le' || encoding === 'utf-16be') {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      throw notValidIn(encoding === 'utf-8' ? 'is read as UTF-8' : `declares ${name}`);
    }
  }
  if (encoding === 'us-ascii' && bytes.some((b) => b > 0x7f)) {
    throw new SwiftMessageError('malformed_message',
      `the message declares ${name} but holds bytes that are not ASCII — `
      + 'it was written in another code page; export it as UTF-8, or declare the encoding it is really in');
  }
  const text = latin1(bytes);
  return encoding === 'windows-1252'
    ? text.replace(/[\x80-\x9f]/g, (c) => WINDOWS_1252_80_9F_CHARS[c.charCodeAt(0) - 0x80]!)
    : text;
}

/** The same bound for every family: no payment message is anywhere near it. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

function bytesAndText(message: string | Uint8Array): { bytes: Uint8Array; text: string } {
  // A string is measured in the UTF-8 bytes it is hashed as: counted in UTF-16
  // units, up to three times the bound got through. No UTF-16 unit is less
  // than one byte of UTF-8, so the length alone refuses first wherever it can.
  if (message.length > MAX_MESSAGE_BYTES
    || (typeof message === 'string' && Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES)) {
    throw new SwiftMessageError('malformed_message',
      `the message is larger than ${MAX_MESSAGE_BYTES} bytes — split the file; no payment message is that large`);
  }
  if (typeof message === 'string') return { bytes: Buffer.from(message, 'utf8'), text: message };
  // What the bytes start with decides how they are read: XML says its own encoding.
  let k = message[0] === 0xef && message[1] === 0xbb && message[2] === 0xbf ? 3 : 0;
  while (k < message.length && (message[k] === 0x20 || message[k] === 0x09 || message[k] === 0x0a || message[k] === 0x0d)) k++;
  const xml = message[k] === 0x3c
    || (message[0] === 0xff && message[1] === 0xfe) || (message[0] === 0xfe && message[1] === 0xff);
  if (xml) return { bytes: message, text: decodeXml(message) };
  let text: string;
  try {
    text = utf8(message);
  } catch {
    // FIN text is ASCII in practice; a legacy export in a single-byte code
    // page still reads correctly for every character the X character set allows.
    text = latin1(message);
    // XML is never read in a guessed code page — not even when something
    // before its first "<" (a no-break space …) kept it from being seen as XML
    // above. It is refused as the same bytes without that character are.
    if (looksLikeXml(text)) throw notValidIn('is read as UTF-8');
  }
  return { bytes: message, text };
}


/**
 * Say, for each payment, whether its identifiers alone tell it from the
 * others in the same text. Where they do, the payment is the same payment
 * wherever in a file it stands; where a system writes the same identifiers
 * on every transaction, only the position is left to tell them apart.
 */
function markDistinct(all: SwiftPayment[]): SwiftPayment[] {
  const key = (p: SwiftPayment): string => JSON.stringify([
    p.messageType, p.messageId ?? '', p.instructionId ?? '',
    ownReference(p.endToEndId) === undefined ? '' : p.endToEndId, p.valueDate ?? '',
  ]);
  const counts = new Map<string, number>();
  for (const p of all) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  for (const p of all) {
    const own = !!p.instructionId || ownReference(p.endToEndId) !== undefined;
    p.distinctIds = own && counts.get(key(p)) === 1;
  }
  return all;
}

/** Every customer credit transfer the message — or the file of messages — carries. */
export function parseSwiftMessages(message: string | Uint8Array): SwiftPayment[] {
  const { bytes, text } = bytesAndText(message);
  if (text.trim() === '') throw new SwiftMessageError('not_a_swift_message', 'the message is empty');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (looksLikeXml(text)) return markDistinct(parseIso20022(text, digest));
  if (looksLikeMt(text)) return markDistinct(parseMt103(text, digest));
  throw new SwiftMessageError('not_a_swift_message',
    'neither an ISO 20022 XML document (pacs.008, pain.001) nor a FIN message (MT103) — '
    + `the text starts with "${text.trim().slice(0, 24).replace(/\s+/g, ' ')}"`);
}

/**
 * The one payment in a message. A message carrying several transactions is
 * refused unless `index` says which one — a payment instruction must never
 * be picked by accident.
 */
export function parseSwiftMessage(message: string | Uint8Array, opts: { index?: number } = {}): SwiftPayment {
  const all = parseSwiftMessages(message);
  if (opts.index !== undefined) {
    const hit = all[opts.index];
    if (!hit) {
      throw new SwiftMessageError('invalid_field',
        `the message carries ${all.length} transaction(s); there is no transaction at index ${opts.index}`);
    }
    return hit;
  }
  if (all.length !== 1) {
    throw new SwiftMessageError('multiple_transactions',
      `the message carries ${all.length} transactions — pass { index } to choose one, or use parseSwiftMessages() to take each in turn`);
  }
  return all[0]!;
}
