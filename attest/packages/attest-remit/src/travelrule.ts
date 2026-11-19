/**
 * Travel Rule, bank-side ("mode B"): the party data is shaped and encrypted
 * here, to the beneficiary institution's key, and the platform relays a
 * ciphertext it cannot open.
 *
 * Mode A hands the party fields to the platform, which builds this same
 * message and encrypts it on the bank's behalf. Mode B is for a bank whose
 * policy keeps customer data inside its own perimeter: of the Travel Rule
 * message, what leaves is the JWE, the digest of the message inside it, and
 * the bank's signed statement that the required fields are present. The
 * beneficiary institution decrypts and checks the fields for real; its
 * signed acknowledgement is the proof.
 *
 * What mode B does not hide: the names of the two companies. They are part
 * of the evidence elements the bank signs (the instruction and the
 * commercial document), which the platform reconciles in both modes. The
 * address, the registration number and the accounts travel only inside the
 * JWE.
 *
 * The message has the corridor's two layers — the underlying trade payment
 * (importer → exporter) and the settlement leg (settlement entity →
 * beneficiary institution) — with IVMS 101 naming for the persons. The
 * encryption is RFC 7516 compact JWE, ECDH-ES (P-256) direct key agreement
 * with A256GCM, on `node:crypto` alone.
 */
import {
  createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes,
} from 'node:crypto';
import type { MappedParties } from './swift/mapping.ts';
import { isLei } from './swift/model.ts';

export interface TravelRuleContext {
  paymentId: string;
  tradeAmount: string;
  tradeCurrency: string;
  purposeCode?: string;
  /** The instructing bank, as the Trust Registry names it. */
  originatingInstitution: { id: string; name: string; country: string };
  beneficiaryInstitution: { id: string; name: string; country: string };
  settlementEntity: { id: string; name: string };
  /** The settlement amount, in USDC. */
  settlementAmount: string;
}

type Party = { name?: string; country?: string; address?: string; registration_number?: string; account?: string };

function legalPerson(p: Party): Record<string, unknown> {
  return {
    legalPerson: {
      name: { nameIdentifier: [{ legalPersonName: p.name ?? '', legalPersonNameIdentifierType: 'LEGL' }] },
      ...(p.address ? {
        geographicAddress: [{ addressType: 'GEOG', addressLine: [p.address], country: p.country ?? '' }],
      } : {}),
      ...(p.registration_number ? {
        // An LEI is typed as one (IVMS 101: LEIX) — the same rule the platform applies in mode A.
        nationalIdentification: {
          nationalIdentifier: p.registration_number,
          nationalIdentifierType: isLei(p.registration_number) ? 'LEIX' : 'RAID',
        },
      } : {}),
      ...(p.country ? { countryOfRegistration: p.country } : {}),
    },
    ...(p.account ? { accountNumber: [p.account] } : {}),
  };
}

/**
 * The Travel Rule message. Field for field what the platform builds in
 * mode A, so the beneficiary institution reads one format whichever mode
 * the bank chose.
 */
export function buildTravelRuleMessage(parties: MappedParties, ctx: TravelRuleContext): Record<string, unknown> {
  const { bank, ...beneficiary } = parties.creditor;
  return {
    schema: 'IVMS101-2023',
    payment_id: ctx.paymentId,
    underlyingPayment: {
      originator: { originatorPersons: [legalPerson(parties.debtor)] },
      beneficiary: { beneficiaryPersons: [legalPerson(beneficiary)] },
      originatingInstitution: {
        institutionId: ctx.originatingInstitution.id,
        name: ctx.originatingInstitution.name,
        country: ctx.originatingInstitution.country,
      },
      beneficiaryLocalBank: bank,
      transaction: {
        amount: ctx.tradeAmount,
        currency: ctx.tradeCurrency,
        ...(ctx.purposeCode ? { purposeCode: ctx.purposeCode } : {}),
      },
    },
    settlementLeg: {
      originatingVasp: { institutionId: ctx.settlementEntity.id, name: ctx.settlementEntity.name },
      beneficiaryVasp: {
        institutionId: ctx.beneficiaryInstitution.id,
        name: ctx.beneficiaryInstitution.name,
        country: ctx.beneficiaryInstitution.country,
      },
      transaction: { amount: ctx.settlementAmount, currency: 'USDC' },
    },
  };
}

function lengthPrefixed(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

/** Concat KDF (RFC 7518 §4.6), one SHA-256 block — all A256GCM needs. */
function concatKdf256(z: Buffer, enc: string): Buffer {
  const bits = Buffer.alloc(4);
  bits.writeUInt32BE(256, 0);
  const otherInfo = Buffer.concat([
    lengthPrefixed(Buffer.from(enc, 'utf8')), lengthPrefixed(Buffer.alloc(0)), lengthPrefixed(Buffer.alloc(0)), bits,
  ]);
  return createHash('sha256').update(Buffer.concat([Buffer.from([0, 0, 0, 1]), z, otherInfo])).digest();
}

/**
 * Encrypt to an institution's P-256 public JWK (from `GET /v1/remit/meta`).
 * Returns the compact form `header..iv.ciphertext.tag`; the empty second
 * part is what direct key agreement looks like.
 */
export function encryptToInstitution(plaintext: Uint8Array, recipientJwk: Record<string, unknown>, kid?: string): string {
  if (recipientJwk.kty !== 'EC' || recipientJwk.crv !== 'P-256') {
    throw new TypeError('the recipient key must be an EC P-256 public JWK');
  }
  const recipient = createPublicKey({ key: recipientJwk as never, format: 'jwk' });
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cek = concatKdf256(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), 'A256GCM');
  const epk = ephemeral.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
  const header = Buffer.from(JSON.stringify({
    alg: 'ECDH-ES', enc: 'A256GCM',
    epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y },
    ...(kid ? { kid } : {}),
  }), 'utf8').toString('base64url');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  cipher.setAAD(Buffer.from(header, 'ascii'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${header}..${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}
