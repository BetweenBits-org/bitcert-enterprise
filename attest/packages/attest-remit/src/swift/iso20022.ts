/**
 * ISO 20022 customer credit transfers → `SwiftPayment`.
 *
 *   pacs.008  FIToFICustomerCreditTransfer        (bank → bank; what CBPR+ carries)
 *   pain.001  CustomerCreditTransferInitiation    (customer → bank)
 *
 * Any version of either is read: the elements taken here have kept their
 * names since the early versions, with three spellings that changed and are
 * accepted both ways (`BIC`→`BICFI`, `BICOrBEI`→`AnyBIC`, a plain
 * `ReqdExctnDt` → `ReqdExctnDt/Dt`). The message may be the document itself
 * or sit inside an envelope beside a Business Application Header — the
 * `Document` element is found wherever it is. A file that holds several
 * documents (a batch wrapper around more than one message) yields every
 * transaction of every one of them; a document of another kind among them
 * refuses the file rather than being passed over — and so do a second
 * message, or anything else, inside one Document, and a message that stands
 * outside a Document beside them.
 *
 * This is a reader for one purpose: lifting the payment out of the message
 * the bank already produces. It does not validate the message against the
 * schema or against any market-practice rulebook, and says nothing about
 * whether a network would accept it.
 */
import { at, child, childrenOf, parseXml, textAt, XmlError } from './xml.ts';
import type { XmlElement } from './xml.ts';
import { assertCurrency, normaliseAmount, uetrOf, SwiftMessageError } from './model.ts';
import type { SwiftAgent, SwiftAmount, SwiftParty, SwiftPayment } from './model.ts';

const ISO_NS = /^urn:iso:std:iso:20022:tech:xsd:([a-z]{4}\.\d{3}\.\d{3}\.\d{2})$/;

const country = (v: string | undefined): string | undefined =>
  (v && /^[A-Z]{2}$/.test(v) ? v : undefined);

/**
 * Structured parts first, free lines next, locality last — one entry per
 * line. Every part the address states is kept, including the care-of line
 * and the unit number the newer versions added.
 */
function addressLines(adr: XmlElement): string[] {
  const t = (name: string): string | undefined => textAt(adr, name);
  const street = [t('StrtNm'), t('BldgNb')].filter(Boolean).join(' ');
  const town = [t('PstCd'), t('TwnNm')].filter(Boolean).join(' ');
  const careOf = t('CareOf');
  const lines = [
    careOf ? `c/o ${careOf}` : undefined,
    t('Dept'), t('SubDept'), t('BldgNm'), street || undefined, t('Flr'), t('UnitNb'), t('PstBx'), t('Room'),
    ...childrenOf(adr, 'AdrLine').map((l) => l.text.trim()),
    t('TwnLctnNm'), town || undefined, t('DstrctNm'), t('CtrySubDvsn'),
  ];
  return lines.filter((l): l is string => typeof l === 'string' && l !== '');
}

function party(el: XmlElement | undefined): SwiftParty {
  const out: SwiftParty = { addressLines: [] };
  if (!el) return out;
  const name = textAt(el, 'Nm');
  if (name) out.name = name;
  const adr = child(el, 'PstlAdr');
  if (adr) {
    out.addressLines = addressLines(adr);
    const c = country(textAt(adr, 'Ctry'));
    if (c) out.country = c;
  }
  if (!out.country) {
    const c = country(textAt(el, 'CtryOfRes'));
    if (c) { out.country = c; out.countryFrom = 'CtryOfRes'; }
  }
  const org = at(el, 'Id/OrgId');
  const person = at(el, 'Id/PrvtId');
  // A private identification says the party is a person, not a company.
  if (person) out.person = true;
  const holder = org ?? person;
  if (org) {
    const bic = textAt(org, 'AnyBIC') ?? textAt(org, 'BICOrBEI') ?? textAt(org, 'BIC');
    if (bic) out.bic = bic;
    const lei = textAt(org, 'LEI');
    if (lei) out.lei = lei;
  }
  // `Othr` may repeat (a tax id beside a customer number); the first is taken.
  const other = childrenOf(holder, 'Othr')[0];
  if (other) {
    const id = textAt(other, 'Id');
    if (id) {
      out.identification = id;
      out.identificationFrom = `Id/${org ? 'OrgId' : 'PrvtId'}/Othr/Id`;
    }
    const scheme = textAt(other, 'SchmeNm/Cd') ?? textAt(other, 'SchmeNm/Prtry');
    if (scheme) out.identificationScheme = scheme;
  }
  return out;
}

function account(el: XmlElement | undefined): string | undefined {
  return textAt(el, 'Id/IBAN') ?? textAt(el, 'Id/Othr/Id');
}

function agent(el: XmlElement | undefined): SwiftAgent | undefined {
  const fin = child(el, 'FinInstnId');
  if (!fin) return undefined;
  const out: SwiftAgent = {};
  const bic = textAt(fin, 'BICFI') ?? textAt(fin, 'BIC');
  if (bic) out.bic = bic;
  const lei = textAt(fin, 'LEI');
  if (lei) out.lei = lei;
  const name = textAt(fin, 'Nm');
  if (name) out.name = name;
  // A clearing-system member id, or else an id under another scheme (`Othr`):
  // an agent the message identifies only that way is still an agent, and is
  // kept with the scheme that id belongs to.
  const member = textAt(fin, 'ClrSysMmbId/MmbId');
  const other = member ? undefined : textAt(fin, 'Othr/Id');
  if (member) out.memberId = member;
  else if (other) out.memberId = other;
  const system = other
    ? textAt(fin, 'Othr/SchmeNm/Cd') ?? textAt(fin, 'Othr/SchmeNm/Prtry')
    : textAt(fin, 'ClrSysMmbId/ClrSysId/Cd') ?? textAt(fin, 'ClrSysMmbId/ClrSysId/Prtry');
  if (system) out.clearingSystem = system;
  const c = country(textAt(fin, 'PstlAdr/Ctry'));
  if (c) out.country = c;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** An amount is an xs:decimal: a full stop or nothing — `12,500` is not read as twelve and a half. */
function amountOf(el: XmlElement | undefined, field: string): SwiftAmount | undefined {
  if (!el) return undefined;
  return { currency: assertCurrency(el.attrs.Ccy, `${field}/@Ccy`), value: normaliseAmount(el.text, field, { decimalComma: false }) };
}

/** `2026-11-17`, from a date, a date-time, or a `Dt` / `DtTm` choice. */
function dateOf(el: XmlElement | undefined): string | undefined {
  if (!el) return undefined;
  const raw = textAt(el, 'Dt') ?? textAt(el, 'DtTm') ?? (el.text.trim() || undefined);
  const m = raw ? /^(\d{4}-\d{2}-\d{2})/.exec(raw) : null;
  return m ? m[1] : undefined;
}

/**
 * `/INV/…` references inside free remittance text — the MT convention, which
 * survives translation into ISO 20022. A reference runs to the next coded
 * word (`/RFB/`, `/ROC/` …) or the end of the line, so a slash inside the
 * reference itself (`INV/2026/001`, `EQP/SGP/2026/0457`) is kept.
 */
/**
 * The coded words of MT field 70, which also survive in ISO 20022 free
 * text: invoice, international payment instruction, reference for the
 * beneficiary, the ordering customer's reference, trade services utility.
 * A reference ends at the next of these — not at any three capital letters
 * between slashes, which an invoice number may well contain.
 */
export const REMITTANCE_CODES = 'INV|IPI|RFB|ROC|TSU';

/**
 * The UETR under `PmtId`. An element that is there but empty states nothing,
 * as every empty optional element does here: a serialiser writes `<UETR/>`
 * for "no value". (An MT103's empty field 121 is a different thing — nothing
 * writes a FIN field without its value — and that reader refuses it.) The
 * payment is still recognised when it comes again with its UETR: by its
 * identifiers, value date and content.
 */
function uetrIn(id: XmlElement | undefined): string | undefined {
  return uetrOf(textAt(id, 'UETR'), 'PmtId/UETR');
}

export function invoiceTokens(text: string): string[] {
  const out: string[] = [];
  // `.*?`, not `.+?`: an empty code word ("/INV//ROC/PO-1") carries no reference — with one
  // character required, the next code word itself was taken for the invoice.
  const re = new RegExp(`/INV/(.*?)(?=/(?:${REMITTANCE_CODES})/|\\n|$)`, 'gs');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Several references under one code word are separated by "//".
    for (const part of m[1]!.split('//')) {
      const ref = part.trim().replace(/\/$/, '').trim();
      if (ref) out.push(ref);
    }
  }
  return out;
}

/** Referred-document types that are an invoice: commercial, metered-service, hire, self-billed. */
const INVOICE_TYPES = new Set(['CINV', 'MSIN', 'HIRI', 'SBIN']);

/**
 * What the remittance information says the payment is for.
 *
 * A structured referred document counts as an invoice when the message
 * types it as one, or does not type it. A purchase order or a credit note
 * is a document of another kind and is kept apart — it must not become the
 * invoice reference because it happens to stand first. Invoices the message
 * types explicitly come first, then untyped documents, then `/INV/` words
 * in free text.
 */
function remittance(rmt: XmlElement | undefined): { info: string[]; invoices: string[]; others: string[] } {
  const info: string[] = [];
  const typed: string[] = [];
  const untyped: string[] = [];
  const tokens: string[] = [];
  const others: string[] = [];
  for (const u of childrenOf(rmt, 'Ustrd')) {
    const t = u.text.trim();
    if (!t) continue;
    info.push(t);
    // One at a time: spread into push(), a line of 125,000 references
    // overflowed the call stack.
    for (const token of invoiceTokens(t)) tokens.push(token);
  }
  for (const s of childrenOf(rmt, 'Strd')) {
    for (const doc of childrenOf(s, 'RfrdDocInf')) {
      const nb = textAt(doc, 'Nb');
      if (!nb) continue;
      const type = textAt(doc, 'Tp/CdOrPrtry/Cd') ?? textAt(doc, 'Tp/CdOrPrtry/Prtry');
      if (!type) untyped.push(nb);
      else if (INVOICE_TYPES.has(type)) typed.push(nb);
      else others.push(`${type} ${nb}`);
    }
    const ref = textAt(s, 'CdtrRefInf/Ref');
    if (ref) info.push(ref);
    for (const add of childrenOf(s, 'AddtlRmtInf')) {
      const t = add.text.trim();
      if (t) info.push(t);
    }
  }
  return { info, invoices: [...new Set([...typed, ...untyped, ...tokens])], others };
}

/**
 * Who bears the charges, as the element states it, or undefined when it is
 * not there. A value outside the code list refuses the message, as an unknown
 * MT 71A does: passed over, it vanished — and in a pain.001 transaction it hid
 * the value its payment block states.
 */
function chargeBearerOf(el: XmlElement, where: string): SwiftPayment['chargeBearer'] {
  const v = textAt(el, 'ChrgBr');
  if (v === undefined || v === 'DEBT' || v === 'CRED' || v === 'SHAR' || v === 'SLEV') return v;
  throw new SwiftMessageError('invalid_field', `${where}: "${v}" is not DEBT, CRED, SHAR or SLEV`, where);
}

/** Charges the message states: amount, and the agent that took them when named. */
function chargesOf(tx: XmlElement): string[] {
  return childrenOf(tx, 'ChrgsInf').map((c) => {
    const amt = child(c, 'Amt');
    const agentBic = textAt(c, 'Agt/FinInstnId/BICFI') ?? textAt(c, 'Agt/FinInstnId/BIC');
    const text = amt ? `${amt.text.trim()} ${amt.attrs.Ccy ?? ''}`.trim() : '';
    return [text, agentBic ? `(${agentBic})` : ''].filter(Boolean).join(' ');
  }).filter((c) => c !== '');
}

function regulatory(tx: XmlElement): string[] {
  const out: string[] = [];
  for (const r of childrenOf(tx, 'RgltryRptg')) {
    for (const d of childrenOf(r, 'Dtls')) {
      // `Tp` is plain text in the older versions and a code-or-proprietary
      // choice in the newer ones; `Cd` was renamed `RptgCd`.
      const parts = [textAt(d, 'Tp') ?? textAt(d, 'Tp/Cd') ?? textAt(d, 'Tp/Prtry'),
        textAt(d, 'Cd') ?? textAt(d, 'RptgCd'), textAt(d, 'Ctry'),
        ...childrenOf(d, 'Inf').map((i) => i.text.trim())].filter(Boolean);
      if (parts.length > 0) out.push(parts.join(' '));
    }
  }
  return out;
}

/** The names of an element's own children (its own namespace), each once. */
function names(el: XmlElement | undefined): string[] {
  return el ? [...new Set(el.children.filter((c) => c.ns === el.ns).map((c) => c.name))] : [];
}

interface Family { type: string; body: XmlElement }

/**
 * The message bodies this SDK reads, by element name. A Map, not an object:
 * the name comes from the message, and `<constructor/>` must not find a
 * function on Object.prototype.
 */
const BODIES: ReadonlyMap<string, string> = new Map([['FIToFICstmrCdtTrf', 'pacs.008'], ['CstmrCdtTrfInitn', 'pain.001']]);

/** The version the namespace declares when it is of the body's family; else the family alone. */
function familyOf(body: XmlElement, declared: string | undefined): Family {
  const family = BODIES.get(body.name)!;
  return { type: declared?.startsWith(family) ? declared : family, body };
}

/**
 * Locate the business documents, bare or inside an envelope — every one of
 * them. A wrapper around several messages is a file with several payments;
 * reading only the first would drop the rest without a word. For the same
 * reason a Document carries its one message and nothing else, and a file
 * whose messages stand some inside a Document and some outside is refused:
 * read either way, part of it would be passed over.
 */
function findFamilies(root: XmlElement): Family[] {
  // One walk finds both: every Document (not looked into here — each is read
  // below) and every message body that stands outside a Document. A bare body
  // is walked through for a Document inside it, never for a second body.
  const documents: XmlElement[] = [];
  const bare: XmlElement[] = [];
  const walk = (el: XmlElement, inBody: boolean): void => {
    if (el.name === 'Document') { documents.push(el); return; }
    const body = !inBody && BODIES.has(el.name);
    if (body) bare.push(el);
    for (const c of el.children) walk(c, inBody || body);
  };
  walk(root, false);

  if (documents.length > 0 && bare.length > 0) {
    throw new SwiftMessageError('malformed_message',
      `<${bare[0]!.name}> stands outside a Document, beside the file's documents — put each message in a Document of its own`);
  }
  // Some hubs strip the Document wrapper.
  if (bare.length > 0) return bare.map((body) => familyOf(body, ISO_NS.exec(body.ns)?.[1]));
  if (documents.length === 0) {
    const ns = ISO_NS.exec(root.ns)?.[1];
    throw new SwiftMessageError('unsupported_message',
      `no pacs.008 or pain.001 document found${ns ? ` (the message declares ${ns})` : ` (root element <${root.name}>)`}`);
  }

  return documents.map((doc, n) => {
    const which = documents.length > 1 ? `document ${n + 1} of ${documents.length}` : 'the document';
    const declared = ISO_NS.exec(doc.ns)?.[1];
    const first = doc.children[0];
    const bodies = doc.children.filter((c) => BODIES.has(c.name));
    if (bodies.length > 1) {
      throw new SwiftMessageError('malformed_message',
        `${which} holds ${bodies.length} messages (${[...new Set(bodies.map((b) => `<${b.name}>`))].join(', ')}) — `
        + 'a Document carries one message; put each in a Document of its own');
    }
    const body = bodies[0];
    if (body) {
      const other = doc.children.find((c) => c !== body);
      if (!other) return familyOf(body, declared);
      throw new SwiftMessageError('unsupported_message',
        `${which} holds <${other.name}> ${other === first ? 'before' : 'after'} its message <${body.name}> — `
        + 'a Document carries its message and nothing else');
    }
    // No message this SDK reads: say what the document holds instead of one, or what it is.
    const expected = declared ? [...BODIES].find(([, family]) => declared.startsWith(family))?.[0] : undefined;
    throw new SwiftMessageError('unsupported_message', expected
      ? `${which} declares ${declared} but holds ${first ? `<${first.name}>` : 'nothing'} where its message <${expected}> belongs`
      : declared
        ? `${which} is ${declared}, not a customer credit transfer — this SDK reads pacs.008 and pain.001 (and MT103)`
        : `${which} holds ${first ? `<${first.name}>` : 'nothing'}, not a customer credit transfer — this SDK reads pacs.008 and pain.001 (and MT103)`);
  });
}

function requireEl(el: XmlElement | undefined, path: string): XmlElement {
  if (!el) throw new SwiftMessageError('missing_field', `${path} is missing`, path);
  return el;
}

function pacs008(family: Family, digest: string): SwiftPayment[] {
  const hdr = child(family.body, 'GrpHdr');
  const messageId = textAt(hdr, 'MsgId');
  const createdAt = textAt(hdr, 'CreDtTm');
  const headerDate = dateOf(child(hdr, 'IntrBkSttlmDt'));
  const txs = childrenOf(family.body, 'CdtTrfTxInf');
  if (txs.length === 0) {
    throw new SwiftMessageError('missing_field', 'CdtTrfTxInf is missing — the message carries no transaction', 'CdtTrfTxInf');
  }
  return txs.map((tx, index): SwiftPayment => {
    const here = `CdtTrfTxInf[${index + 1}]`;
    const id = child(tx, 'PmtId');
    const settlement = amountOf(child(tx, 'IntrBkSttlmAmt'), `${here}/IntrBkSttlmAmt`);
    const instructed = amountOf(child(tx, 'InstdAmt'), `${here}/InstdAmt`);
    const amount = instructed ?? settlement;
    if (!amount) {
      throw new SwiftMessageError('missing_field', `${here}/IntrBkSttlmAmt is missing`, `${here}/IntrBkSttlmAmt`);
    }
    const debtor = party(requireEl(child(tx, 'Dbtr'), `${here}/Dbtr`));
    const debtorAccount = account(child(tx, 'DbtrAcct'));
    if (debtorAccount) debtor.account = debtorAccount;
    const creditor = party(requireEl(child(tx, 'Cdtr'), `${here}/Cdtr`));
    const creditorAccount = account(child(tx, 'CdtrAcct'));
    if (creditorAccount) creditor.account = creditorAccount;
    const rmt = remittance(child(tx, 'RmtInf'));
    const charge = chargeBearerOf(tx, `${here}/ChrgBr`);

    const p: SwiftPayment = {
      format: 'pacs.008', messageType: family.type, digest, index, transactionCount: txs.length,
      amount, debtor, creditor,
      intermediaryAgents: ['IntrmyAgt1', 'IntrmyAgt2', 'IntrmyAgt3']
        .map((n) => agent(child(tx, n))).filter((a): a is SwiftAgent => a !== undefined),
      remittanceInformation: rmt.info,
      invoiceReferences: rmt.invoices,
      otherDocuments: rmt.others,
      charges: chargesOf(tx),
      regulatoryReporting: regulatory(tx),
      present: [...new Set([...(messageId ? ['MsgId'] : []), ...names(id), ...names(tx)])],
    };
    const set = <K extends keyof SwiftPayment>(k: K, v: SwiftPayment[K] | undefined): void => {
      if (v !== undefined) p[k] = v;
    };
    set('messageId', messageId);
    set('createdAt', createdAt);
    set('instructionId', textAt(id, 'InstrId'));
    set('endToEndId', textAt(id, 'EndToEndId'));
    set('transactionId', textAt(id, 'TxId'));
    set('uetr', uetrIn(id));
    set('valueDate', dateOf(child(tx, 'IntrBkSttlmDt')) ?? headerDate);
    set('instructedAmount', instructed);
    set('settlementAmount', settlement);
    set('exchangeRate', textAt(tx, 'XchgRate'));
    if (charge) p.chargeBearer = charge;
    set('debtorAgent', agent(child(tx, 'DbtrAgt')));
    set('creditorAgent', agent(child(tx, 'CdtrAgt')));
    set('purpose', textAt(tx, 'Purp/Cd') ?? textAt(tx, 'Purp/Prtry'));
    return p;
  });
}

function pain001(family: Family, digest: string): SwiftPayment[] {
  const hdr = child(family.body, 'GrpHdr');
  const messageId = textAt(hdr, 'MsgId');
  const createdAt = textAt(hdr, 'CreDtTm');
  const blocks = childrenOf(family.body, 'PmtInf');
  /**
   * What a payment-information block states for all its transactions, read
   * once per block. A salary or supplier run carries thousands of
   * transactions under one block; reading the block's own children again
   * for each of them made a large file quadratic.
   */
  interface Shared {
    debtor: SwiftParty; debtorAgent: SwiftAgent | undefined; valueDate: string | undefined;
    charge: SwiftPayment['chargeBearer']; paymentInfoId: string | undefined; names: string[];
  }
  const flat: { shared: Shared; tx: XmlElement; where: string }[] = [];
  blocks.forEach((info, b) => {
    const txs = childrenOf(info, 'CdtTrfTxInf');
    if (txs.length === 0) return;
    const debtor = party(requireEl(child(info, 'Dbtr'), `PmtInf[${b + 1}]/Dbtr`));
    const debtorAccount = account(child(info, 'DbtrAcct'));
    if (debtorAccount) debtor.account = debtorAccount;
    const shared: Shared = {
      debtor, debtorAgent: agent(child(info, 'DbtrAgt')), valueDate: dateOf(child(info, 'ReqdExctnDt')),
      charge: chargeBearerOf(info, `PmtInf[${b + 1}]/ChrgBr`), paymentInfoId: textAt(info, 'PmtInfId'),
      names: names(info).filter((n) => n !== 'CdtTrfTxInf'),
    };
    txs.forEach((tx, t) => flat.push({ shared, tx, where: `PmtInf[${b + 1}]/CdtTrfTxInf[${t + 1}]` }));
  });
  if (flat.length === 0) {
    throw new SwiftMessageError('missing_field', 'PmtInf/CdtTrfTxInf is missing — the message carries no transaction', 'PmtInf/CdtTrfTxInf');
  }
  return flat.map(({ shared, tx, where }, index): SwiftPayment => {
    const id = child(tx, 'PmtId');
    const instructed = amountOf(at(tx, 'Amt/InstdAmt'), `${where}/Amt/InstdAmt`);
    const equivalent = amountOf(at(tx, 'Amt/EqvtAmt/Amt'), `${where}/Amt/EqvtAmt/Amt`);
    const amount = instructed ?? equivalent;
    if (!amount) throw new SwiftMessageError('missing_field', `${where}/Amt/InstdAmt is missing`, `${where}/Amt/InstdAmt`);
    // Each payment gets its own copy: the block's debtor is one object, and a
    // payment handed to a caller must not change under the next one.
    const debtor: SwiftParty = { ...shared.debtor, addressLines: [...shared.debtor.addressLines] };
    const creditor = party(requireEl(child(tx, 'Cdtr'), `${where}/Cdtr`));
    const creditorAccount = account(child(tx, 'CdtrAcct'));
    if (creditorAccount) creditor.account = creditorAccount;
    const rmt = remittance(child(tx, 'RmtInf'));
    const charge = chargeBearerOf(tx, `${where}/ChrgBr`) ?? shared.charge;

    const p: SwiftPayment = {
      format: 'pain.001', messageType: family.type, digest, index, transactionCount: flat.length,
      amount, debtor, creditor,
      intermediaryAgents: ['IntrmyAgt1', 'IntrmyAgt2', 'IntrmyAgt3']
        .map((n) => agent(child(tx, n))).filter((a): a is SwiftAgent => a !== undefined),
      remittanceInformation: rmt.info,
      invoiceReferences: rmt.invoices,
      otherDocuments: rmt.others,
      charges: [],
      regulatoryReporting: regulatory(tx),
      present: [...new Set([...(messageId ? ['MsgId'] : []), ...shared.names, ...names(id), ...names(tx)])],
    };
    const set = <K extends keyof SwiftPayment>(k: K, v: SwiftPayment[K] | undefined): void => {
      if (v !== undefined) p[k] = v;
    };
    set('messageId', messageId);
    set('createdAt', createdAt);
    // The block's id is not the instruction's: every transaction of the block shares it.
    set('instructionId', textAt(id, 'InstrId'));
    set('paymentInfoId', shared.paymentInfoId);
    set('endToEndId', textAt(id, 'EndToEndId'));
    set('uetr', uetrIn(id));
    set('valueDate', shared.valueDate);
    set('instructedAmount', instructed);
    set('exchangeRate', textAt(tx, 'XchgRateInf/XchgRate'));
    if (charge) p.chargeBearer = charge;
    set('debtorAgent', shared.debtorAgent);
    set('creditorAgent', agent(child(tx, 'CdtrAgt')));
    set('purpose', textAt(tx, 'Purp/Cd') ?? textAt(tx, 'Purp/Prtry'));
    return p;
  });
}

/**
 * Does the envelope say the message is a test? Two places say so: a
 * messaging-interface header naming a pilot service (`…!p`), and a test and
 * training BIC — "0" in the eighth position — as sender or receiver in the
 * Business Application Header. A message body that stands without a
 * Document is walked as well, its own agents with it: a test BIC found there
 * still marks the message, and is reported by the path it stands at — not as
 * a header the message does not have.
 */
function testMarker(root: XmlElement): { where: string; what: string } | undefined {
  let hit: { where: string; what: string } | undefined;
  const path: string[] = [];
  const walk = (el: XmlElement, inHeader: boolean): void => {
    if (hit || el.name === 'Document') return;
    path.push(el.name);
    const header = inHeader || el.name === 'AppHdr';
    const text = el.text.trim();
    if (el.name === 'Service' && /!p$/i.test(text)) hit = { where: 'envelope header, Service', what: `pilot service ${text}` };
    else if (el.name === 'BICFI' && /^[A-Z0-9]{7}0([A-Z0-9]{3})?$/.test(text)) {
      hit = { where: header ? 'Business Application Header' : path.join('/'), what: `test and training BIC ${text}` };
    } else for (const c of el.children) walk(c, header);
    path.pop();
  };
  walk(root, false);
  return hit;
}

/** Does this text start like an XML document? */
export function looksLikeXml(text: string): boolean {
  return /^﻿?\s*</.test(text);
}

/**
 * Every transaction of every pacs.008 / pain.001 document in the text, in
 * the order they appear. `index` counts across the whole text.
 */
export function parseIso20022(text: string, digest: string): SwiftPayment[] {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (e) {
    if (e instanceof XmlError) throw new SwiftMessageError('malformed_message', `not well-formed XML: ${e.message}`);
    throw e;
  }
  let all: SwiftPayment[];
  try {
    all = findFamilies(root).flatMap((family) =>
      (family.type.startsWith('pacs.008') ? pacs008(family, digest) : pain001(family, digest)));
    const test = testMarker(root);
    if (test) for (const p of all) p.test = test;
  } catch (e) {
    // An element that may occur once and occurs twice: the message can be read two ways.
    if (e instanceof XmlError) throw new SwiftMessageError('malformed_message', e.message);
    throw e;
  }
  all.forEach((p, index) => { p.index = index; p.transactionCount = all.length; });
  return all;
}
