/**
 * One customer credit transfer, as the bank's own message states it.
 *
 * Three message families describe the same payment in three vocabularies —
 * ISO 20022 `pacs.008` (bank to bank), ISO 20022 `pain.001` (customer to
 * bank) and the FIN `MT103`. Each parser fills this one shape and nothing
 * else, so everything downstream (the mapping onto a settlement
 * instruction, the status report going back) is written once.
 *
 * The rule the parsers follow: **record what the message says, infer
 * nothing.** A country that the message does not state stays undefined
 * here; whether it may be inferred from an agent's BIC is the mapping
 * layer's decision, and it is reported when it happens.
 */

export type SwiftFormat = 'pacs.008' | 'pain.001' | 'MT103';

export interface SwiftAmount {
  /** ISO 4217 alphabetic code. */
  currency: string;
  /** Decimal string with a full stop, no grouping — `1000.00`. */
  value: string;
}

export interface SwiftParty {
  name?: string;
  /** ISO 3166-1 alpha-2, when the message states one. */
  country?: string;
  /** The address as carried, one entry per line. */
  addressLines: string[];
  /** Legal Entity Identifier (ISO 17442). */
  lei?: string;
  bic?: string;
  /** Another identification: `Othr/Id`, or an MT option-F party identifier. */
  identification?: string;
  /** What that identification is, as the message labels it (`TXID`, `CUST` …). */
  identificationScheme?: string;
  /** Where in the message the identification stands, in the message's own words. */
  identificationFrom?: string;
  /** Where the country was stated, when it was not the postal address. */
  countryFrom?: string;
  /**
   * The message identifies this party as a private person: a `PrvtId`, a
   * date or place of birth, or a personal document (passport, national
   * identity number …).
   */
  person?: boolean;
  /** IBAN or other account identification. */
  account?: string;
}

export interface SwiftAgent {
  bic?: string;
  lei?: string;
  name?: string;
  /**
   * Clearing-system member id, when the agent is identified that way — or,
   * for an agent the message identifies only under another scheme, that id
   * (`FinInstnId/Othr/Id`).
   */
  memberId?: string;
  /** Which clearing system (`USABA`, `SGIBG` …) or other scheme (`Othr/SchmeNm`) that id belongs to, when stated. */
  clearingSystem?: string;
  country?: string;
}

export interface SwiftPayment {
  format: SwiftFormat;
  /** `pacs.008.001.08`, `pain.001.001.09`, `MT103` … as the message declares. */
  messageType: string;
  /** SHA-256 (hex) over the exact text handed to the parser. */
  digest: string;
  /** Position of this transaction in the text handed over, from 0. */
  index: number;
  /** How many transactions that text carries. */
  transactionCount: number;
  /**
   * No other transaction of the same text carries these message, instruction
   * and end-to-end identifiers — the identifiers alone tell this payment from
   * its neighbours, wherever in a file it stands. Set by `parseSwiftMessages`.
   */
  distinctIds?: boolean;

  /** Group header `MsgId`, or the MT sender's reference (field 20). */
  messageId?: string;
  instructionId?: string;
  /** pain.001: the identification of the payment-information block the transaction belongs to. */
  paymentInfoId?: string;
  endToEndId?: string;
  transactionId?: string;
  /** Unique end-to-end transaction reference (UUID v4), lower case. */
  uetr?: string;
  /** Message creation time, as given. */
  createdAt?: string;
  /** Settlement / requested execution / value date, `YYYY-MM-DD`. */
  valueDate?: string;

  /** The amount the payment is for: instructed amount, else settlement amount. */
  amount: SwiftAmount;
  instructedAmount?: SwiftAmount;
  settlementAmount?: SwiftAmount;
  exchangeRate?: string;
  /** ISO 20022 charge bearer; MT 71A is translated (OUR→DEBT, BEN→CRED, SHA→SHAR). */
  chargeBearer?: 'DEBT' | 'CRED' | 'SHAR' | 'SLEV';
  /** Charges the message states (`ChrgsInf`, MT 71F / 71G), as given. */
  charges: string[];
  /** MT103 field 23B — `CRED`, `SPAY`, `SSTD`, `SPRI`, or `CRTS` for a test message. */
  bankOperationCode?: string;
  /**
   * Set when the message says of itself that it is a test: field 23B `CRTS`,
   * a test and training BIC in the header, a pilot service. `where` is the
   * place in the message, `what` the value found there.
   */
  test?: { where: string; what: string };

  debtor: SwiftParty;
  debtorAgent?: SwiftAgent;
  creditor: SwiftParty;
  creditorAgent?: SwiftAgent;
  intermediaryAgents: SwiftAgent[];

  /** Purpose code or proprietary purpose, as given. */
  purpose?: string;
  /** Unstructured remittance information, one entry per occurrence / line. */
  remittanceInformation: string[];
  /** Invoice references: documents the message types as an invoice, or does not type at all. */
  invoiceReferences: string[];
  /** Referred documents of another kind (purchase order, credit note …): `PUOR PO-88812`. */
  otherDocuments: string[];
  regulatoryReporting: string[];

  /**
   * What the message contained, by its own names: ISO 20022 element names
   * for the XML families, field tags (`20`, `32A`, `50K` …) for MT103.
   */
  present: string[];
}

export type SwiftErrorCode =
  | 'not_a_swift_message'
  | 'unsupported_message'
  | 'malformed_message'
  | 'multiple_transactions'
  | 'missing_field'
  | 'invalid_field';

/** A message that could not be read, with the place it went wrong. */
export class SwiftMessageError extends Error {
  readonly code: SwiftErrorCode;
  /** Element path or field tag at fault, when there is one. */
  readonly field: string | undefined;
  constructor(code: SwiftErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'SwiftMessageError';
    this.code = code;
    this.field = field;
  }
}

/**
 * `1000,5` / `1000.50` → a plain decimal string, or throw naming the field.
 *
 * `decimalComma` takes a comma as the decimal mark, as FIN does (`1000,5`),
 * and only a reader of FIN turns it on. An ISO 20022 amount is an xs:decimal,
 * which has no comma at all: there `12,500` is refused rather than taken as
 * twelve and a half — and that is the default, so that a caller who says
 * nothing cannot read a thousands separator as a decimal mark.
 */
export function normaliseAmount(raw: string, field: string, opts: { decimalComma?: boolean } = {}): string {
  const t = opts.decimalComma === true ? raw.trim().replace(',', '.') : raw.trim();
  const m = /^(\d{1,15})(?:\.(\d{0,5}))?$/.exec(t);
  if (!m) throw new SwiftMessageError('invalid_field', `${field}: "${raw}" is not an amount`, field);
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  const frac = m[2] ?? '';
  return frac === '' ? whole : `${whole}.${frac}`;
}

export function assertCurrency(raw: string | undefined, field: string): string {
  if (!raw || !/^[A-Z]{3}$/.test(raw)) {
    throw new SwiftMessageError('invalid_field', `${field}: "${raw ?? ''}" is not a currency code`, field);
  }
  return raw;
}

/**
 * Lower-case a UETR after checking it has the shape of a UUID. The standard
 * asks for version 4; this is a reader, not a validator of the sender, so a
 * UUID of another version is kept — the reference is for correlation.
 */
export function normaliseUetr(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t) ? t : undefined;
}

/**
 * The UETR a message states, or undefined when it states none. A value that is
 * there but is not a UUID refuses the message: read as "no UETR" the payment
 * would be known by its other references instead, its status report would not
 * name the UETR the bank's system printed, and the corrected message sent
 * afterwards would be a second payment.
 */
export function uetrOf(raw: string | undefined, where: string): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const uetr = normaliseUetr(raw);
  if (!uetr) {
    throw new SwiftMessageError('invalid_field',
      `the UETR in ${where} ("${raw.trim().slice(0, 48)}") is not a UUID — correct it in the message; `
      + 'a payment is not given another identity because its UETR could not be read', where);
  }
  return uetr;
}

/** The two country letters of a BIC (positions 5–6), or undefined. */
export function bicCountry(bic: string | undefined): string | undefined {
  if (!bic) return undefined;
  const m = /^[A-Z0-9]{4}([A-Z]{2})[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.exec(bic.trim().toUpperCase());
  return m ? m[1] : undefined;
}

export function isLei(value: string | undefined): boolean {
  return !!value && /^[A-Z0-9]{18}[0-9]{2}$/.test(value);
}
