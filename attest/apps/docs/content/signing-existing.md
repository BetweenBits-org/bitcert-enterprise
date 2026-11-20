# Existing signer · HSM/KMS

Use the private key matching the public key already registered in Integrate. You do not need a new key or to send a private key to the platform. Choosing an issuer key is separate from choosing a signing tool.

## 1. Register the public key and prepare the request

With Document Anchoring activated, register an ES256 (P-256) public key in **Integrate → Register a public key**. Reuse it if already registered. Export only the public half from an HSM/KMS. To extract it from a private PEM file on your own machine:

```bash
openssl pkey -in issuer-private.pem -pubout -out issuer-public.pem
```

In **Document Anchoring → Add an issuer signature**, choose the document, check the registered key label and fingerprint, and download `signing-request.json`. It contains the document hash, public key and issue time, without the original document or private key. Download a new request if the document or key changes.

## 2. Prepare the signing bytes

Download the tools and checksum from [Issuer Signing](#signing). Use Node 22.18 or later:

```bash
sha256sum -c attest-sign.sha256
tar xzf attest-sign.tar.gz
```
```bash
node packages/attest-sign/src/cli.ts prepare \
  --statement signing-request.json --input-out signing-input.bin
```

`signing-input.bin` contains the domain separator and canonical request. Signing only the document hash string does not produce a valid signature for this protocol. Confirm the request public key matches the actual signing key.

## 3. Sign with your private key

For ES256 (P-256), sign all of `signing-input.bin` using ECDSA with SHA-256. On a machine holding a private PEM file:

```bash
openssl dgst -sha256 -sign issuer-private.pem \
  -out signature.der signing-input.bin
```

For an HSM/KMS, use your signing API or adapter on the same bytes and save the signature as `signature.der`. Keep the private key in its device. Check whether the API expects raw input or a precomputed digest to avoid hashing twice. The assembly tool accepts both DER and 64-byte raw ES256 signatures.

## 4. Assemble and verify in the console

```bash
node packages/attest-sign/src/cli.ts assemble \
  --statement signing-request.json --signature signature.der --out signed.json
```

The tool verifies against the request public key and writes `signed.json`. With the same document and registered key selected, choose the signed result file in the console or paste its complete JSON. Document match, selected public key match and signature validity must all pass. The server checks that the key is still active in your organisation.

Revoked keys and keys belonging to another organisation are refused. After switching keys, download a new request and sign again. **Do not upload a private key file.**
