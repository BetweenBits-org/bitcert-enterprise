/**
 * IVMS 101 mapping — mode A (server mode): the bank submits the party data in
 * the settlement request, the relay shapes it into an IVMS 101 message,
 * validates the fields the corridor requires, encrypts it to the BFI and
 * keeps only the digest and the ciphertext.
 *
 * Two layers in one message, per the architecture's travel-rule model (§6-1):
 * the **underlying trade payment** (importer → exporter, the parties a
 * regulator asks about) and the **settlement leg** (settlement entity → BFI,
 * the institutions actually moving USDC). Which layer is the legal
 * originator/beneficiary depends on the transaction's classification, so the
 * message carries both and deletes neither.
 *
 * What is deliberately absent: KYC documents, beneficial-owner identity, risk
 * scores, anything STR-adjacent. The bank sends review *results*, never the
 * review.
 */

export interface CompliancePartyInput {
  name?: string;
  country?: string;
  address?: string;
  registration_number?: string;
  account?: string;
  bank?: string;
}

export interface CompliancePayloadInput {
  format?: string;
  mode?: string;
  originator?: CompliancePartyInput;   // importing company (trade layer)
  beneficiary?: CompliancePartyInput;  // exporting company (trade layer)
  purpose_code?: string;
}

export interface Ivms101Context {
  paymentId: string;
  tradeAmount: string;
  tradeCurrency: string;
  originatingInstitution: { id: string; name: string; country: string };
  beneficiaryInstitution: { id: string; name: string; country: string };
  settlementEntity: { id: string; name: string };
  usdcAmount: string;
}

/** Field paths the corridor requires. Returned to the bank from the quote. */
export const REQUIRED_TRAVEL_RULE_FIELDS = [
  'originator.name', 'originator.country', 'originator.address', 'originator.registration_number',
  'beneficiary.name', 'beneficiary.country', 'beneficiary.account', 'beneficiary.bank',
] as const;

export function missingTravelRuleFields(p: CompliancePayloadInput): string[] {
  const read = (path: string): unknown => {
    const [a, b] = path.split('.') as [keyof CompliancePayloadInput, string];
    const section = p[a];
    if (!section || typeof section !== 'object') return undefined;
    return (section as Record<string, unknown>)[b];
  };
  return REQUIRED_TRAVEL_RULE_FIELDS.filter((f) => {
    const v = read(f);
    return typeof v !== 'string' || v.trim() === '';
  });
}

function legalPerson(p: CompliancePartyInput): Record<string, unknown> {
  return {
    legalPerson: {
      name: { nameIdentifier: [{ legalPersonName: p.name ?? '', legalPersonNameIdentifierType: 'LEGL' }] },
      ...(p.address ? {
        geographicAddress: [{ addressType: 'GEOG', addressLine: [p.address], country: p.country ?? '' }],
      } : {}),
      ...(p.registration_number ? {
        // An LEI is typed as one (IVMS 101: LEIX). Any other number is carried
        // as a registration-authority identifier without naming the authority,
        // which the corridor's party data does not carry yet.
        nationalIdentification: {
          nationalIdentifier: p.registration_number,
          nationalIdentifierType: /^[A-Z0-9]{18}[0-9]{2}$/.test(p.registration_number) ? 'LEIX' : 'RAID',
        },
      } : {}),
      ...(p.country ? { countryOfRegistration: p.country } : {}),
    },
    ...(p.account ? { accountNumber: [p.account] } : {}),
  };
}

/**
 * Build the IVMS 101 message. Deterministic for given inputs — the digest the
 * evidence carries is over the JCS form of exactly this object.
 */
export function buildIvms101(input: CompliancePayloadInput, ctx: Ivms101Context): Record<string, unknown> {
  return {
    schema: 'IVMS101-2023',
    payment_id: ctx.paymentId,
    // Layer 1 — the underlying trade payment.
    underlyingPayment: {
      originator: { originatorPersons: [legalPerson(input.originator ?? {})] },
      beneficiary: { beneficiaryPersons: [legalPerson(input.beneficiary ?? {})] },
      originatingInstitution: {
        institutionId: ctx.originatingInstitution.id,
        name: ctx.originatingInstitution.name,
        country: ctx.originatingInstitution.country,
      },
      beneficiaryLocalBank: input.beneficiary?.bank ?? '',
      transaction: {
        amount: ctx.tradeAmount,
        currency: ctx.tradeCurrency,
        ...(input.purpose_code ? { purposeCode: input.purpose_code } : {}),
      },
    },
    // Layer 2 — the institutional USDC settlement leg.
    settlementLeg: {
      originatingVasp: { institutionId: ctx.settlementEntity.id, name: ctx.settlementEntity.name },
      beneficiaryVasp: {
        institutionId: ctx.beneficiaryInstitution.id,
        name: ctx.beneficiaryInstitution.name,
        country: ctx.beneficiaryInstitution.country,
      },
      transaction: { amount: ctx.usdcAmount, currency: 'USDC' },
    },
  };
}
