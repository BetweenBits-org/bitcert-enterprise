/**
 * The sandbox's starting data, as constants rather than files.
 *
 * The service reads nothing from disk at runtime — every path it uses comes
 * from the environment — and a sandbox that needed to locate a fixture inside
 * `node_modules` would be the one thing that broke that. These are the same
 * two documents the test suite loads from `fixtures/` and `policies/`;
 * `test/samples.test.ts` fails if the copies drift apart, so there is one
 * source of truth even though there are two spellings of it.
 *
 * The evidence is synthetic and says so in its own fields. The policy travels
 * with every request on purpose: a verdict whose rule set is unstated cannot
 * be checked by the person receiving it.
 */
import type { Policy, SettlementEvidence } from './types.ts';

/** Scenario A, before any transform. Every other scenario derives from this. */
export const SAMPLE_SETTLEMENT: SettlementEvidence = {
  schemaVersion: 'settlement-evidence/0.1',
  scenario: 'A · normal trade payment (VN→SG import)',
  dataMode: 'SYNTHETIC',
  notRealPayment: true,
  jurisdiction: {
    from: 'VN',
    to: 'SG',
  },
  purpose: 'Import payment for goods under INV-2026-001',
  elements: {
    chainTransfer: {
      chain: 'Ethereum',
      asset: 'USDC',
      amount: '50000.00',
      currency: 'USDC',
      fromAddress: '0xSYNTHETIC-PAYER-0000000000000000000000',
      toAddress: '0xSYNTHETIC-PAYEE-0000000000000000000000',
      txRef: 'SYNTHETIC-TX-NOT-ON-CHAIN',
      confirmations: 24,
      observedAt: '2026-03-04T08:15:00Z',
      digest: '1f0c2b9a4e7d6c5b8a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b',
      digestVerified: true,
      signature: {
        status: 'ABSENT',
      },
    },
    payoutReceipts: [
      {
        ref: 'PAY-REF-01',
        amount: '50000.00',
        currency: 'USD',
        paidAt: '2026-03-04T09:02:00Z',
        digest: '2b1c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a',
        digestVerified: true,
        signature: {
          status: 'DEMO_VALID',
          keyId: 'demo-provider-key-01',
          algorithm: 'ES256',
          issuer: 'DEMO_PROVIDER',
          trustLevel: 'DEMO',
          value: 'Jo4KXUmwS0nUUhBOJ6PcaZSyTNEOktkpU6elXQ9G966VBnoBI6UMb3xjCVxut0eI9Bad7FcLpZzLfxLTzhBbAQ',
        },
      },
    ],
    bankInstruction: {
      ref: 'INV-2026-001',
      amount: '50000.00',
      currency: 'USD',
      debtor: 'Acme Trading Co., Ltd.',
      creditor: 'Pacific Supply Pte Ltd',
      approvedAt: '2026-03-03T11:40:00Z',
      iso20022Fields: [
        'Dbtr',
        'Cdtr',
        'InstdAmt',
        'Ccy',
        'RmtInf',
        'INV-2026-001',
      ],
      digest: '3c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b',
      digestVerified: true,
      signature: {
        status: 'DEMO_VALID',
        keyId: 'demo-bank-key-01',
        algorithm: 'ES256',
        issuer: 'DEMO_BANK',
        trustLevel: 'DEMO',
        value: '1lD3X2pxa0MP_zeGrylEdT7f2bWJUUYo1ii4kISNl0Bgl5xBlG0a7B77yHtLdm-dwCkOkhjwGceRzIhRzaqd_g',
      },
    },
    commercialDocs: {
      invoiceRef: 'INV-2026-001',
      amount: '50000.00',
      currency: 'USD',
      buyer: 'Acme Trading Corporation',
      seller: 'Pacific Supply Pte. Ltd.',
      attached: [
        'invoice',
        'contract',
        'bill-of-lading',
        'customs-declaration',
      ],
      citedOnly: [],
      digest: '4d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c',
      digestVerified: true,
      signature: {
        status: 'DEMO_VALID',
        keyId: 'demo-seller-key-01',
        algorithm: 'ES256',
        issuer: 'DEMO_SELLER',
        trustLevel: 'DEMO',
        value: 'c_PyHW2HBkXOcv9riO3XQAjNcsbM4cmq2RORHW25vje6UwaB4PPOnmv3wWbyvVWizdInKB_iij0wXbZLZtCzdw',
      },
    },
  },
};

/** The rule set the sandbox evaluates against unless the caller sends another. */
export const SAMPLE_POLICY: Policy = {
  policyVersion: 'settlement-match-v1',
  currencies: [
    'USD',
    'USDC',
  ],
  unitOfAccountGroups: [
    [
      'USD',
      'USDC',
    ],
  ],
  amountTolerance: '0.00',
  amountToleranceBps: 0,
  fxReference: null,
  settlementWindow: 'P3D',
  fees: {
    deductible: false,
    maxBps: 0,
  },
  splitPayments: {
    allowed: true,
    aggregate: true,
  },
  partyIDMatch: 'normalized',
  sourceTrustLevel: 'ATTESTED',
  requiredElements: [
    'chainTransfer',
    'payoutReceipts',
    'bankInstruction',
    'commercialDocs',
  ],
  signatureRequiredElements: [
    'payoutReceipts',
    'bankInstruction',
    'commercialDocs',
  ],
  regulatoryFields: [
    'originator',
    'beneficiary',
    'amount',
    'currency',
    'purpose',
    'jurisdictionFrom',
    'jurisdictionTo',
    'chainTxRef',
    'originatorAddress',
    'beneficiaryAddress',
    'invoiceRef',
    'payoutRef',
    'iso20022',
  ],
  requireTravelRulePreflight: false,
  enforceFxQuoteWindow: false,
  settlementIdRequiredIn: [],
};
