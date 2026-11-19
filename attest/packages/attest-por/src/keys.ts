/**
 * Signing-key provisioning — the server-side counterpart of the console's
 * in-browser key mint.
 *
 * A bank does not run its instruction-signing key through a browser: the
 * pair is generated where the private key will live (an HSM host, a KMS
 * wrapper, a locked-down server) and only the public half ever reaches the
 * platform. `generateSigningKey` is the reference implementation of that
 * generation; `registerIssuerKey` is the one call that publishes the public
 * half. Activation in the console then lists the registered keys, so the
 * key an engineer provisions here is the one the operator picks.
 */
import { generateKeyPairSync } from 'node:crypto';

export interface GeneratedSigningKey {
  /**
   * PKCS#8 PEM. This is the only copy there will ever be — the platform
   * never sees it and cannot recover it. Write it with mode 0600 (or import
   * it into your HSM/KMS) before the process exits.
   */
  privateKeyPem: string;
  /** SPKI DER, base64 — exactly what `registerIssuerKey` sends. */
  publicKeySpkiBase64: string;
}

/** ES256 (P-256) pair, generated locally. Nothing leaves this process. */
export function generateSigningKey(): GeneratedSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeySpkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

/**
 * Register the public half with the platform (`POST /v1/issuer-keys`,
 * Bearer key auth). Idempotent on key material: registering the same key
 * twice returns the existing id with `already: true`.
 */
export async function registerIssuerKey(opts: {
  core: string;
  apiKey: string;
  publicKeySpkiBase64: string;
  label?: string;
}): Promise<{ id: string; already: boolean }> {
  const res = await fetch(`${opts.core.replace(/\/+$/, '')}/v1/issuer-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      public_key: opts.publicKeySpkiBase64,
      label: opts.label ?? 'sdk',
    }),
  });
  const body = await res.json().catch(() => ({})) as { id?: string; already?: boolean; error?: string; message?: string };
  if (!res.ok) {
    throw new Error(`issuer key registration failed (${res.status} ${body.error ?? ''}): ${body.message ?? 'no detail'}`);
  }
  return { id: body.id!, already: body.already === true };
}
