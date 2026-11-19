/**
 * `SwiftPayment` → what a settlement instruction needs.
 *
 * The mapping is a table, and the table is the product: for every value the
 * instruction carries it records where in the bank's message it came from
 * and on what basis —
 *
 *   stated     taken verbatim from the message
 *   inferred   derived from something the message does state (a country
 *              from an agent's BIC), and reported as such
 *   supplied   given by the bank outside the message (its customer master)
 *
 * — and for everything the corridor requires that the message does not
 * carry, an issue that names the missing element in the message's own
 * vocabulary and says how to provide it. Nothing is guessed silently and
 * nothing in the message is dropped silently: content with no place in the
 * corridor is listed under `unmapped` with the reason.
 */
import { createHash } from 'node:crypto';
import { bicCountry, isLei } from './model.ts';
import type { SwiftPayment } from './model.ts';

/** The same shape `RemitClient.buildInstruction` takes. */
export interface MappedParties {
  debtor: { name: string; country: string; address: string; registration_number: string; account?: string };
  creditor: { name: string; country: string; account: string; bank: string };
}

/** Values for what the message does not carry (or states too loosely). */
export interface PartySupplement {
  debtor?: Partial<MappedParties['debtor']>;
  creditor?: Partial<MappedParties['creditor']>;
  invoiceRef?: string;
  purposeCode?: string;
}

export interface SwiftMappingOptions {
  /**
   * What the bank knows beyond the message — typically its customer master,
   * looked up by the debtor's account. A value given here wins over the
   * message's, because a customer record is firmer than a free-text line.
   */
  supplement?: PartySupplement;
  /** The currency the corridor denominates trades in. Sandbox: USD. */
  tradeCurrency?: string;
  /** Take a missing party country from its agent's BIC. Default true; always reported. */
  inferCountryFromBic?: boolean;
  /**
   * Let a message marked as a test through (MT103 field 23B `CRTS`, a test
   * and training BIC in the header, a pilot service). The client sets it for
   * a test key and for nothing else: such a message must not be executed as
   * a payment.
   */
  allowTestMessages?: boolean;
  /**
   * The route the instruction will be quoted on. A payment whose ordering
   * customer is not in `origin`, or whose beneficiary or beneficiary's bank
   * is not in `destination`, is not a payment of this corridor and is
   * refused — not quoted on it because its currency happened to fit.
   * Default: VN → SG, the sandbox corridor.
   */
  corridor?: { origin: string; destination: string };
}

export type MappingBasis = 'stated' | 'inferred' | 'supplied';

export interface MappedField {
  /** Where the value goes in the instruction. */
  target: string;
  value: string;
  /** Where it came from, in the message's own vocabulary. */
  source: string;
  basis: MappingBasis;
}

export interface SwiftMappingIssue {
  /** The instruction field that cannot be filled. */
  target: string;
  /** Where the message would have carried it. */
  source: string;
  problem: string;
  /** What to do about it. */
  fix: string;
}

export interface SwiftUnmapped {
  source: string;
  value: string;
  why: string;
}

/** Reference to the bank's message, as it is signed into the instruction. */
export interface SourceMessageRef {
  /** `pacs.008.001.08`, `pain.001.001.09`, `MT103`. */
  type: string;
  /** SHA-256 (hex) of the message exactly as the bank's system wrote it. */
  sha256: string;
  /** Position inside a multi-transaction message, from 0. */
  index?: number;
  messageId?: string;
  instructionId?: string;
  /** pain.001: the payment-information block the transaction belongs to. */
  paymentInfoId?: string;
  endToEndId?: string;
  uetr?: string;
  /** The message's settlement / requested execution / value date, `YYYY-MM-DD`. */
  valueDate?: string;
  /**
   * SHA-256 (hex) over what makes this payment this payment, as the message
   * states it: the amounts, both parties' names and accounts, the payment's
   * own identifiers and its remittance text. A re-export of the same payment
   * — a new envelope, a new creation time, other whitespace — keeps it;
   * another payment that reuses the reference does not. It is how a repeat
   * is told from a reused reference without the instruction carrying an
   * account number in clear. See `swiftContentDigest`.
   */
  content?: string;
}

export interface SwiftInstructionInput {
  tradeAmount: string;
  tradeCurrency: string;
  parties: MappedParties;
  invoiceRef: string;
  purposeCode?: string;
  /** The bank's own reference for the instruction, when the message has one. */
  instructionRef?: string;
  source: SourceMessageRef;
  /** Element names / field tags present in the message. */
  messageFields: string[];
}

export interface SwiftMapping {
  payment: SwiftPayment;
  /** Present exactly when `issues` is empty. */
  input?: SwiftInstructionInput;
  fields: MappedField[];
  issues: SwiftMappingIssue[];
  unmapped: SwiftUnmapped[];
}

/** Thrown when a message cannot become an instruction; carries every reason at once. */
export class SwiftMappingError extends Error {
  readonly issues: SwiftMappingIssue[];
  readonly mapping: SwiftMapping;
  constructor(mapping: SwiftMapping) {
    super(`the message cannot be turned into a settlement instruction — ${mapping.issues.length} thing(s) missing: `
      + mapping.issues.map((i) => `${i.target} (${i.source})`).join('; '));
    this.name = 'SwiftMappingError';
    this.issues = mapping.issues;
    this.mapping = mapping;
  }
}

/** Where each family carries a thing — used in the mapping table and in issues. */
function vocabulary(p: SwiftPayment): Record<string, string> {
  if (p.format === 'MT103') {
    return {
      debtorName: 'field 50a (name line)', debtorAddress: 'field 50a (address lines)',
      debtorCountry: 'field 50F line 3/ or field 77B /ORDERRES/', debtorId: 'field 50F party identifier or line 6/ 7/',
      debtorAccount: 'field 50a (/account line)', debtorAgent: 'field 52A or the sender BIC',
      creditorName: 'field 59a (name line)', creditorCountry: 'field 59F line 3/ or field 77B /BENEFRES/',
      creditorAccount: 'field 59a (/account line)', creditorAgent: 'field 57a or the receiver BIC',
      amount: 'field 32A', settled: 'field 32A', instructed: 'field 33B',
      invoice: 'field 70 /INV/', purpose: 'field 26T',
      charges: 'field 71A', rate: 'field 36', valueDate: 'field 32A', intermediary: 'field 56a',
      regulatory: 'field 77B', chargeAmounts: 'field 71F / 71G', person: 'field 50F',
      debtorParty: 'field 50', creditorParty: 'field 59',
    };
  }
  const tx = p.format === 'pain.001' ? 'PmtInf' : 'CdtTrfTxInf';
  return {
    debtorName: `${tx}/Dbtr/Nm`, debtorAddress: `${tx}/Dbtr/PstlAdr`, debtorCountry: `${tx}/Dbtr/PstlAdr/Ctry`,
    debtorId: `${tx}/Dbtr/Id/OrgId (LEI or Othr/Id)`, debtorAccount: `${tx}/DbtrAcct/Id`,
    debtorAgent: `${tx}/DbtrAgt/FinInstnId/BICFI`,
    creditorName: 'CdtTrfTxInf/Cdtr/Nm', creditorCountry: 'CdtTrfTxInf/Cdtr/PstlAdr/Ctry',
    creditorAccount: 'CdtTrfTxInf/CdtrAcct/Id', creditorAgent: 'CdtTrfTxInf/CdtrAgt/FinInstnId',
    amount: p.format === 'pain.001' ? 'CdtTrfTxInf/Amt' : 'CdtTrfTxInf/IntrBkSttlmAmt',
    settled: 'CdtTrfTxInf/IntrBkSttlmAmt',
    instructed: p.format === 'pain.001' ? 'CdtTrfTxInf/Amt/InstdAmt' : 'CdtTrfTxInf/InstdAmt',
    invoice: 'CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)', purpose: 'CdtTrfTxInf/Purp',
    charges: 'ChrgBr', rate: 'XchgRate', valueDate: p.format === 'pain.001' ? 'PmtInf/ReqdExctnDt' : 'IntrBkSttlmDt',
    intermediary: 'IntrmyAgt1…3', regulatory: 'RgltryRptg', chargeAmounts: 'ChrgsInf', person: 'Id/PrvtId',
    debtorParty: `${tx}/Dbtr`, creditorParty: 'CdtTrfTxInf/Cdtr',
  };
}

const NOT_PROVIDED = /^(NOTPROVIDED|NONREF|NOREF)$/i;

/**
 * The payment's own reference, trimmed — or undefined when it gives none: an
 * empty value, or one of the words the standards write where there is no
 * reference (`NOTPROVIDED`, `NONREF`, `NOREF`), in any case and whatever
 * white space surrounds it. The one notion of "no reference", wherever a
 * reference is read.
 */
export function ownReference(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t && !NOT_PROVIDED.test(t) ? t : undefined;
}

/** A value as the message states it, trimmed. An empty one, or white space alone, is no value. */
const given = (value: string | undefined): string | undefined => value?.trim() || undefined;

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Two amounts compared exactly, as the decimal strings they are (`12500.00`,
 * `7000.5`): -1, 0 or 1 as `a` is less than, equal to or more than `b`;
 * undefined when either is not a plain decimal — digits, then optionally a
 * full stop and digits. Never as floating-point numbers: past the fifteenth
 * significant digit, two different amounts are the same number.
 */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 | undefined {
  const x = DECIMAL.exec(a);
  const y = DECIMAL.exec(b);
  if (!x || !y) return undefined;
  const xWhole = x[1]!.replace(/^0+/, '');
  const yWhole = y[1]!.replace(/^0+/, '');
  if (xWhole.length !== yWhole.length) return xWhole.length < yWhole.length ? -1 : 1;
  // Whole parts of one length, fractions padded to one length: the digits compare as text.
  const width = Math.max(x[2]?.length ?? 0, y[2]?.length ?? 0);
  const xDigits = xWhole + (x[2] ?? '').padEnd(width, '0');
  const yDigits = yWhole + (y[2] ?? '').padEnd(width, '0');
  return xDigits === yDigits ? 0 : xDigits < yDigits ? -1 : 1;
}

/** The first `n` characters of `s`, counted by code point: a surrogate pair is never cut in two. */
function firstCodePoints(s: string, n: number): string {
  let out = '';
  let count = 0;
  for (const ch of s) {
    if (count++ === n) break;
    out += ch;
  }
  return out;
}

/**
 * A fingerprint of the payment a message describes — not of the message.
 *
 * Covered: the instructed and the settlement amount, the debtor's and the
 * creditor's name and account, the instruction, end-to-end and transaction
 * identifiers, the invoice references and the remittance text. Left out on
 * purpose: everything that changes when the same payment is written out
 * again — the message id, the creation time, the value date, whitespace —
 * and the UETR, which is the reference being checked. Agents are left out
 * too: the same MT103 names its receiver in a header block that an exporter
 * may strip.
 */
export function swiftContentDigest(payment: SwiftPayment): string {
  const tidy = (v: string | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim();
  const money = (a: { currency: string; value: string } | undefined): string =>
    (a ? `${a.currency} ${a.value.includes('.') ? a.value.replace(/0+$/, '').replace(/\.$/, '') : a.value}` : '');
  const e2e = ownReference(payment.endToEndId) ?? '';
  return createHash('sha256').update(JSON.stringify([
    'stonehash:swift:content:v1',
    money(payment.instructedAmount), money(payment.settlementAmount), money(payment.amount),
    tidy(payment.debtor.name), tidy(payment.debtor.account),
    tidy(payment.creditor.name), tidy(payment.creditor.account),
    tidy(payment.instructionId), tidy(e2e), tidy(payment.transactionId),
    payment.invoiceReferences.map(tidy), payment.remittanceInformation.map(tidy),
  ])).digest('hex');
}

/** Map one parsed payment. Never throws for missing data — it reports. */
export function mapSwiftPayment(payment: SwiftPayment, opts: SwiftMappingOptions = {}): SwiftMapping {
  const v = vocabulary(payment);
  const sup = opts.supplement ?? {};
  const tradeCurrency = given(opts.tradeCurrency) ?? 'USD';
  const fields: MappedField[] = [];
  const issues: SwiftMappingIssue[] = [];
  const unmapped: SwiftUnmapped[] = [];

  /** Resolve one target: the bank's supplement first, then the message, then an inference. */
  const pick = (target: string, source: string, supplied: string | undefined,
    stated: string | undefined, inferred?: { value: string | undefined; from: string }): string | undefined => {
    const s = supplied?.trim();
    if (s) { fields.push({ target, value: s, source: 'supplement', basis: 'supplied' }); return s; }
    const m = stated?.trim();
    if (m) { fields.push({ target, value: m, source, basis: 'stated' }); return m; }
    const i = inferred?.value?.trim();
    if (i) { fields.push({ target, value: i, source: inferred!.from, basis: 'inferred' }); return i; }
    return undefined;
  };
  const missing = (target: string, source: string, problem: string, fix: string): void => {
    issues.push({ target, source, problem, fix });
  };
  const infer = opts.inferCountryFromBic !== false;
  const supplementHint = (path: string): string =>
    `add it to the message, or pass it as supplement.${path} (from your customer master)`;

  // ── Amount ───────────────────────────────────────────────────────────────
  // The trade amount is what the beneficiary is owed, and what the bank
  // collected for. Where the message states both an instructed and an
  // interbank amount in the corridor's currency, that is the smaller of the
  // two: with the charges on the beneficiary or shared, the interbank amount
  // is the instructed one less what was deducted; with the charges on the
  // debtor, the interbank amount may be the instructed one plus charges
  // prepaid for the receiving bank, which are not the beneficiary's money.
  const settled = payment.settlementAmount;
  const instructed = payment.instructedAmount;
  let amount = payment.amount;
  let amountSource = v.amount!;
  if (settled?.currency === tradeCurrency && instructed?.currency === tradeCurrency) {
    // Compared as the decimals they are: as floating-point numbers, two amounts
    // that differ past the fifteenth significant digit compared equal, and the
    // larger was taken. One that is not a plain decimal cannot be put in
    // order — it is the one taken, so that the check below refuses it by name.
    const order = compareDecimal(instructed.value, settled.value);
    const useInstructed = order === undefined ? !DECIMAL.test(instructed.value) : order < 0;
    amount = useInstructed ? instructed : settled;
    amountSource = useInstructed ? v.instructed! : v.settled!;
  } else if (settled?.currency === tradeCurrency) {
    amount = settled;
    amountSource = v.settled!;
  } else if (instructed?.currency === tradeCurrency) {
    amount = instructed;
    amountSource = v.instructed!;
  }
  let tradeAmount: string | undefined;
  if (amount.currency !== tradeCurrency) {
    missing('trade.amount', amountSource,
      `the message instructs ${amount.value} ${amount.currency}; this corridor denominates trades in ${tradeCurrency}`,
      `send the ${tradeCurrency} amount of the trade (the corridor converts the funding and payout legs itself, from the quote)`);
  } else if (!/^\d+(\.\d{1,2})?$/.test(amount.value) || /^0+(\.0+)?$/.test(amount.value)) {
    missing('trade.amount', amountSource,
      `"${amount.value}" is not a positive ${tradeCurrency} amount with at most two decimals`,
      'correct the amount in the message');
  } else {
    tradeAmount = amount.value;
    fields.push({ target: 'trade.amount', value: `${amount.value} ${amount.currency}`, source: amountSource, basis: 'stated' });
  }

  // A message marked as a test is not a payment.
  // …unless this client uses a test key: then, and only then, the mark does not stop it.
  const testTaken = !!payment.test && !!opts.allowTestMessages;
  if (payment.test && !testTaken) {
    missing('instruction', payment.test.where, `${payment.test.what} — the message is marked as a test and must not be executed as a payment`,
      'send it as a real payment; a test message is taken only with a test key');
  }

  // ── Debtor (the Travel Rule originator) ──────────────────────────────────
  const mt = payment.format === 'MT103';
  /** A party's own element or field, for a value read from a place the vocabulary does not name by default. */
  const within = (base: string, place: string | undefined, fallback: string): string =>
    (place ? (place.startsWith('field ') ? place : `${base}${mt ? ' ' : '/'}${place}`) : fallback);
  // The corridor's Travel Rule data describes two companies. A party the
  // message identifies as a private person would be sent as a legal person.
  const refusePerson = (target: string, base: string, role: string): void => {
    missing(target, `${base}${mt ? '' : '/Id/PrvtId'}`,
      `the ${role} is identified as a private person (a private identification, a date or place of birth, or a personal document)`,
      'this corridor carries payments between companies — send a payment by or to a private person through the channel you use for it today');
  };

  const d = payment.debtor;
  if (d.person) refusePerson('debtor', v.debtorParty!, 'ordering customer');
  const debtorName = pick('debtor.name', v.debtorName!, sup.debtor?.name, d.name);
  if (!debtorName) missing('debtor.name', v.debtorName!, 'the ordering customer has no name', supplementHint('debtor.name'));

  const debtorCountry = pick('debtor.country', within(v.debtorParty!, d.countryFrom, mt ? 'field 50F line 3/' : `${v.debtorParty}/PstlAdr/Ctry`),
    sup.debtor?.country, d.country,
    infer ? { value: bicCountry(payment.debtorAgent?.bic), from: `${v.debtorAgent} (country letters of the BIC)` } : undefined);
  if (!debtorCountry) {
    missing('debtor.country', v.debtorCountry!, 'the ordering customer\'s country is not stated',
      supplementHint('debtor.country'));
  }

  const debtorAddress = pick('debtor.address', v.debtorAddress!, sup.debtor?.address,
    d.addressLines.length > 0 ? d.addressLines.join(', ') : undefined);
  if (!debtorAddress) {
    missing('debtor.address', v.debtorAddress!, 'the ordering customer has no address — the receiving institution requires one',
      supplementHint('debtor.address'));
  }

  // A BIC names the party on a network; it is not the registration number
  // the receiving institution asks for, and is not passed off as one.
  // An empty LEI is no LEI: it does not hide the identification the message does state.
  const statedId = given(d.lei) ?? given(d.identification);
  const idSource = given(d.lei) ? `${v.debtorParty}/Id/OrgId/LEI`
    : `${within(v.debtorParty!, d.identificationFrom, v.debtorId!)}${d.identificationScheme ? ` — ${d.identificationScheme}` : ''}`;
  const debtorId = pick('debtor.registration_number', idSource, sup.debtor?.registration_number, statedId);
  if (!debtorId) {
    missing('debtor.registration_number', v.debtorId!,
      `the ordering customer carries no identification (LEI, business registration number or tax id)${d.bic ? ` — only the BIC ${d.bic}, which is not one` : ''}; the receiving institution requires one`,
      supplementHint('debtor.registration_number'));
  }

  const debtorAccount = pick('debtor.account', v.debtorAccount!, sup.debtor?.account, d.account);

  // ── Creditor (the Travel Rule beneficiary) ───────────────────────────────
  const c = payment.creditor;
  if (c.person) refusePerson('creditor', v.creditorParty!, 'beneficiary');
  const creditorName = pick('creditor.name', v.creditorName!, sup.creditor?.name, c.name);
  if (!creditorName) missing('creditor.name', v.creditorName!, 'the beneficiary has no name', supplementHint('creditor.name'));

  // From the bank's BIC, or else from the country its address states — each labelled as what it is.
  const agentBicCountry = bicCountry(payment.creditorAgent?.bic);
  const creditorCountry = pick('creditor.country', within(v.creditorParty!, c.countryFrom, mt ? 'field 59F line 3/' : `${v.creditorParty}/PstlAdr/Ctry`),
    sup.creditor?.country, c.country,
    !infer ? undefined : agentBicCountry
      ? { value: agentBicCountry, from: `${v.creditorAgent} (country letters of the BIC)` }
      : { value: payment.creditorAgent?.country,
        from: `${v.creditorAgent}${mt ? '' : '/PstlAdr/Ctry'} (the country of the beneficiary's bank)` });
  if (!creditorCountry) {
    missing('creditor.country', v.creditorCountry!, 'the beneficiary\'s country is not stated',
      supplementHint('creditor.country'));
  }

  const creditorAccount = pick('creditor.account', v.creditorAccount!, sup.creditor?.account, c.account);
  if (!creditorAccount) {
    missing('creditor.account', v.creditorAccount!, 'the beneficiary has no account — the payout cannot be credited',
      supplementHint('creditor.account'));
  }

  // Every identification the message gives for the beneficiary's bank is
  // carried: a name alone loses the routing number, a number alone does not
  // say which clearing system it belongs to.
  const agent = payment.creditorAgent;
  const bankParts = agent ? [
    agent.name,
    agent.bic ? (agent.name ? `BIC ${agent.bic}` : agent.bic) : undefined,
    agent.memberId ? `${given(agent.clearingSystem) ?? 'clearing member'} ${agent.memberId}` : undefined,
  ].filter((x): x is string => !!x) : [];
  const creditorBank = pick('creditor.bank', v.creditorAgent!, sup.creditor?.bank,
    bankParts.length > 0 ? bankParts.join(' · ') : undefined);
  if (!creditorBank) {
    missing('creditor.bank', v.creditorAgent!, 'the beneficiary\'s bank is not identified',
      supplementHint('creditor.bank'));
  }

  // ── The route ────────────────────────────────────────────────────────────
  // Checked on what will be sent, after the customer master has had its say.
  const corridor = opts.corridor ?? { origin: 'VN', destination: 'SG' };
  const fix = 'send this payment through the channel you use for that route today';
  if (debtorCountry && debtorCountry !== corridor.origin) {
    missing('corridor', v.debtorCountry!,
      `the ordering customer is in ${debtorCountry}; this corridor carries payments from ${corridor.origin} to ${corridor.destination}`, fix);
  }
  if (creditorCountry && creditorCountry !== corridor.destination) {
    missing('corridor', v.creditorCountry!,
      `the beneficiary is in ${creditorCountry}; this corridor carries payments from ${corridor.origin} to ${corridor.destination}`, fix);
  }
  const payoutCountry = bicCountry(agent?.bic) ?? given(agent?.country);
  if (payoutCountry && payoutCountry !== corridor.destination) {
    missing('corridor', v.creditorAgent!,
      `the beneficiary's bank is in ${payoutCountry}; the payout of this corridor is made in ${corridor.destination}`, fix);
  }

  // ── References ───────────────────────────────────────────────────────────
  // Trimmed before it is tested: "NOTPROVIDED" with a line end after it is still no reference.
  const e2e = ownReference(payment.endToEndId);
  // At most 64 characters, counted by code point: cut by UTF-16 unit, the line
  // could end in half of a surrogate pair, and that half was signed into the instruction.
  // (`== null`: a payment handed over already parsed may hold an entry that says nothing;
  // it is no line, not a reason to stop with a TypeError.)
  const firstLine = payment.remittanceInformation[0] as string | null | undefined;
  const remittanceLine = firstLine == null ? undefined
    : firstCodePoints(firstLine.replace(/\s+/g, ' ').trim(), 64).trimEnd();
  // The first invoice reference that says something; an empty entry is no invoice.
  let invoiceRef = pick('invoice_ref', v.invoice!, sup.invoiceRef, payment.invoiceReferences.find((r) => r.trim() !== ''));
  if (!invoiceRef && e2e) {
    invoiceRef = e2e;
    fields.push({ target: 'invoice_ref', value: e2e, source: 'end-to-end identification (no invoice reference in the message)', basis: 'inferred' });
  }
  if (!invoiceRef && remittanceLine) {
    invoiceRef = remittanceLine;
    fields.push({ target: 'invoice_ref', value: remittanceLine, source: 'first line of the remittance information', basis: 'inferred' });
  }
  if (!invoiceRef) {
    missing('invoice_ref', v.invoice!,
      'nothing in the message identifies the commercial basis of the payment (no invoice reference, end-to-end id or remittance text)',
      'carry the invoice number in the remittance information, or pass supplement.invoiceRef');
  }
  const purposeCode = pick('purpose_code', v.purpose!, sup.purposeCode, payment.purpose);

  const source: SourceMessageRef = {
    type: payment.messageType, sha256: payment.digest, content: swiftContentDigest(payment),
    ...(payment.valueDate ? { valueDate: payment.valueDate } : {}),
  };
  if (payment.transactionCount > 1) source.index = payment.index;
  if (payment.paymentInfoId) source.paymentInfoId = payment.paymentInfoId;
  for (const k of ['messageId', 'instructionId', 'endToEndId', 'uetr'] as const) {
    // "NOTPROVIDED" is the standard's way of saying there is no end-to-end id.
    const val = k === 'endToEndId' ? e2e : payment[k];
    if (val) {
      source[k] = val;
      fields.push({ target: `sourceMessage.${k}`, value: val, source: k === 'uetr'
        ? (payment.format === 'MT103' ? 'block 3, field 121' : 'PmtId/UETR')
        : (payment.format === 'MT103' ? (k === 'endToEndId' ? 'field 70 /ROC/' : 'field 20') : k === 'messageId' ? 'GrpHdr/MsgId'
          : k === 'instructionId' ? 'PmtId/InstrId' : 'PmtId/EndToEndId'), basis: 'stated' });
    }
  }

  // ── What the corridor has no place for ───────────────────────────────────
  if (payment.chargeBearer) {
    unmapped.push({ source: v.charges!, value: payment.chargeBearer,
      why: 'charges follow the quote: the platform fee is added to the funding leg and the beneficiary is paid the full trade amount' });
  }
  if (payment.exchangeRate) {
    unmapped.push({ source: v.rate!, value: payment.exchangeRate,
      why: 'both conversion rates are fixed by the quote the instruction cites, not by the message' });
  }
  if (payment.valueDate) {
    unmapped.push({ source: v.valueDate!, value: payment.valueDate,
      why: 'settlement starts when the instruction is accepted; there is no forward value date' });
  }
  for (const a of payment.intermediaryAgents) {
    unmapped.push({ source: v.intermediary!, value: given(a.bic) ?? given(a.name) ?? given(a.memberId) ?? '?',
      why: 'the corridor has no correspondent chain — the settlement entity pays the beneficiary institution directly' });
  }
  const plain = (a: { currency: string; value: string }): string =>
    `${a.value.includes('.') ? a.value.replace(/0+$/, '').replace(/\.$/, '') : a.value} ${a.currency}`;
  if (instructed && settled && plain(instructed) !== plain(settled)) {
    const other = amount === settled ? instructed : settled;
    const sameCurrency = instructed.currency === settled.currency;
    unmapped.push({ source: amount === settled ? v.instructed! : v.settled!,
      value: `${other.value} ${other.currency}`,
      why: amount === settled
        ? (sameCurrency
          ? 'charges were deducted on the way: the interbank amount is what the beneficiary is owed, and what is sent'
          : 'the interbank amount is in the corridor\'s currency and names the trade; the instructed amount is the same payment before conversion')
        : (sameCurrency
          ? 'the interbank amount includes charges prepaid for the receiving bank; the beneficiary is owed the instructed amount, and that is what is sent'
          : 'the instructed amount is in the corridor\'s currency and names the trade; the settlement leg is recomputed from the quote') });
  }
  for (const charge of payment.charges) {
    unmapped.push({ source: v.chargeAmounts!, value: charge,
      why: 'charges follow the quote: the platform fee is added to the funding leg; a charge the message records stays with the bank\'s own accounting' });
  }
  // Compared as the reference taken was: trimmed. An empty entry is no further invoice.
  for (const extra of payment.invoiceReferences.filter((r) => r.trim() !== '' && r.trim() !== invoiceRef)) {
    unmapped.push({ source: v.invoice!, value: extra,
      why: 'the instruction carries one commercial reference; a further invoice stays in the bank\'s message, whose digest the instruction cites' });
  }
  for (const doc of payment.otherDocuments) {
    unmapped.push({ source: 'RmtInf/Strd/RfrdDocInf', value: doc,
      why: 'a referred document that is not an invoice (a purchase order, a credit note …) — it is not the commercial reference' });
  }
  if (payment.test && testTaken) {
    unmapped.push({ source: payment.test.where, value: payment.test.what,
      why: 'the message is marked as a test; it is taken because this client uses a test key, and a live key refuses it' });
  }
  if (payment.present.includes('77T')) {
    unmapped.push({ source: 'field 77T', value: '(present)',
      why: 'not read — the envelope contents of an MT103 REMIT stay in the bank\'s message; carry the invoice reference in field 70' });
  }
  for (const r of payment.regulatoryReporting) {
    unmapped.push({ source: v.regulatory!, value: r,
      why: 'regulatory reporting stays with the bank\'s own reporting system and is not forwarded' });
  }
  for (const name of ['UltmtDbtr', 'UltmtCdtr', 'InstrForCdtrAgt', 'InstrForNxtAgt', '72', '23E']) {
    if (payment.present.includes(name)) {
      unmapped.push({ source: /^\d/.test(name) ? `field ${name}` : name, value: '(present)',
        why: 'not read — the corridor carries the debtor and the creditor only, and no agent instructions' });
    }
  }

  const mapping: SwiftMapping = { payment, fields, issues, unmapped };
  if (issues.length === 0) {
    // An empty instruction id does not hide the block's id or the message's.
    const instructionRef = given(payment.instructionId) ?? given(payment.paymentInfoId) ?? given(payment.messageId);
    mapping.input = {
      tradeAmount: tradeAmount!,
      tradeCurrency,
      parties: {
        debtor: {
          name: debtorName!, country: debtorCountry!, address: debtorAddress!, registration_number: debtorId!,
          ...(debtorAccount ? { account: debtorAccount } : {}),
        },
        creditor: { name: creditorName!, country: creditorCountry!, account: creditorAccount!, bank: creditorBank! },
      },
      invoiceRef: invoiceRef!,
      ...(purposeCode ? { purposeCode } : {}),
      ...(instructionRef ? { instructionRef } : {}),
      source,
      messageFields: payment.present,
    };
  }
  return mapping;
}

/** `LEIX` when the registration number is an LEI — what IVMS 101 calls it. */
export function identifierKind(registrationNumber: string): 'LEI' | 'other' {
  return isLei(registrationNumber) ? 'LEI' : 'other';
}
