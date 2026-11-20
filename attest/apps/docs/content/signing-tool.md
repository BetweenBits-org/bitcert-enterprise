# Our Docker · SDK

Run our signer in your environment. Both Docker and Node need the private key matching the registered public key selected in the console. Do not generate a new key for every signature.

## 1. Get the tools

Download the source and checksum from [Issuer Signing](#signing), verify and extract them. The Node path requires version 22.18 or later.

```bash
sha256sum -c attest-sign.sha256
tar xzf attest-sign.tar.gz
```
```bash
docker build -t attest-sign -f packages/attest-sign/Dockerfile .
```

This is a local image built from the downloaded source. You may run the same CLI with Node instead. For an existing PEM key or HSM/KMS, follow the [existing signer guide](#signing-existing).

## 2. Prepare the key and register its public half

Skip this step if you already have an `issuer.key.json` from our tool and have registered its public key. Only generate a pair if you need a new key, then extract the public half to a separate file:

```bash
docker run --rm --network=none -v "$PWD:/work" \
  attest-sign keygen --out /work/issuer.key.json
node --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; const key=JSON.parse(readFileSync("issuer.key.json","utf8")); writeFileSync("issuer-public.txt",key.publicKeySpkiBase64+"\n");'
```

Keep `issuer.key.json`, which contains the private key, in your own environment. In **Integrate → Register a public key**, paste only the contents of `issuer-public.txt`. Never register or upload the private key file. Return to Document Anchoring, choose the document and registered key, and download `signing-request.json`.

## 3. Sign the request file

Place the matching `issuer.key.json` and downloaded request in your working directory:

```bash
docker run --rm --network=none -v "$PWD:/work" \
  attest-sign sign --key /work/issuer.key.json \
  --statement /work/signing-request.json --out /work/signed.json
```

Without Docker:

```bash
node packages/attest-sign/src/cli.ts sign --key issuer.key.json \
  --statement signing-request.json --out signed.json
```

`--statement` signs the exact hash, public key and issue time prepared by the console. Download a new request after changing the document or key. A signature made with another key will fail console verification.

## 4. Import the signed result

Choose `signed.json` in the console or paste its complete JSON. Check that the document, registered public key and signature checks pass, then anchor with the signature. Only the signed result is sent; the private key and original document are not. The server also checks the selected key's organisation and revocation state.
