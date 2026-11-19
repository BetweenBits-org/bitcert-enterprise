# Issuer Signing

Anchoring proves a document existed by a block height. It says nothing about
**who** published it — anyone can hash a file. Adding an issuer signature
closes that gap, and this page is how.

Signing is **optional**. `POST /v1/attestations` is unchanged and remains the
default; nothing below is required to anchor a document.

## The one rule

**Your private key never reaches us.** There is no endpoint that accepts one
and no column that could store it. A signature we could have produced would
prove nothing about you, so the key stays on your machine and this page exists
to make that practical rather than merely stated.

What you send is the **signed statement**: the document's digest, your public
key, and the signature. Nothing else.

## Download

<!-- DOWNLOADS -->

### Verify what you downloaded

```bash
sha256sum -c attest-sign.sha256
tar xzf attest-sign.tar.gz
```

It runs as-is, with no install step — the package has no dependencies. Node ≥ 22.18 runs the `.ts` sources directly (older 22.x: add `--experimental-strip-types`):

```bash
node packages/attest-sign/src/cli.ts --help
```

### Build the container

There is **no image on a public registry**, deliberately: an image you pull
is an image you are trusting, and this one generates private keys. Build it
from the sources you just checksummed instead.

```bash
docker build -t attest-sign -f packages/attest-sign/Dockerfile .
```

The build copies files and does nothing else — no bundler, no minifier, no
package manager, no network. Two builds of the same sources produce the same
image, so you can compare digests rather than trust anyone's.

You can also read what you are about to run:

```bash
docker run --rm --entrypoint cat attest-sign /app/src/index.ts
```

To move it to a host with no internet — which is the right place for a
signing key — carry the image across yourself:

```bash
docker save attest-sign | gzip > attest-sign-image.tar.gz   # ~50 MB
# on the offline host:
docker load -i attest-sign-image.tar.gz
```

## Use it

### 1 — Make a key, once

```bash
docker run --rm --network=none -v "$PWD:/work" \
  attest-sign keygen --out /work/issuer.key.json
```

`--network=none` is not decoration. The tool opens no sockets — a test in the
repository asserts that — and running it with the network cut makes the claim
something you observe rather than accept. `--offline-check` goes further and
makes the tool *refuse to run* where a network is reachable.

The private key is written to the path you named, mode `0600`, and nowhere
else. We never receive it and cannot recover it.

### 2 — Sign a digest

The console shows the digest of the document you selected. Carry those 64
characters to the signing machine — **not the document**:

```bash
docker run --rm --network=none -v "$PWD:/work" \
  attest-sign sign --key /work/issuer.key.json \
    --digest 7cda0d6f4184f4c79476d675aee469a0d847b987f595b566b0ddb8f1156643ba
```

This is the safest arrangement available: the machine holding your key never
sees the document at all. The signature was always over the digest, so nothing
is lost by never moving the file.

If the document *is* on that machine, `--file contract.pdf` hashes it and
signs in one step. Compare the printed digest against `sha256sum` yourself.

### 3 — Paste the result back

The console checks the signature **in your browser**, before anything is sent:
that the signature covers the statement, and that the statement's digest
matches the document you selected. A mistake fails in front of the person who
can fix it rather than for a recipient months later.

## As a library

Not on npm — take it from the tarball above. It has no dependencies, so
there is nothing to install:

```ts
import { generateKey, signStatement } from './packages/attest-sign/src/index.ts';   // '@stonehash/attest-sign' once it is on npm

const key = await generateKey();            // ES256 by default; 'RS256' also accepted
const statement = await signStatement(key, {
  documentSha256: '7cda…',
  contentType: 'application/pdf',
});
// POST { statement } to /v1/attestations/signed
```

`generateKey` draws from the platform CSPRNG and returns the only copy. Where
it goes next is your decision — an HSM, a KMS, a file on an offline host. The
library deliberately does not choose, and does not touch the filesystem at all.

## Sign with an HSM or a KMS

A bank's signing key lives in hardware and does not come out — which is
right, and nothing here asks otherwise. The tool splits signing into two
halves so the key never has to exist as a file: building the exact bytes to
sign happens here, with no key involved; signing them happens wherever the
key lives.

Use a key dedicated to this purpose, minted in the same hardware under the
same ceremony — not one that already signs something else. One key, one
duty: a shared key couples this system's security to another's, and ties
its registry entry to that system's certificate lifecycle.

### 1 — Prepare

```bash
node packages/attest-sign/src/cli.ts prepare \
  --digest 7cda0d6f4184f4c79476d675aee469a0d847b987f595b566b0ddb8f1156643ba \
  --public-key issuer-public.pem
```

`--public-key` takes the public half only — PEM, raw DER, bare base64, or a
key file this tool generated. Two files come out: `prepared.json`, the
statement, and `signing-input.bin`, the exact bytes to sign. The algorithm
is read from the key itself; `--algorithm` overrides.

### 2 — Sign, where the key lives

ECDSA P-256 over SHA-256 — or RSA PKCS#1 v1.5 over SHA-256 — across the
whole of `signing-input.bin`:

```bash
# OpenSSL, including PKCS#11 engines in front of an HSM
openssl dgst -sha256 -sign issuer.key -out sig.der signing-input.bin

# AWS KMS
aws kms sign --key-id <key-id> --message fileb://signing-input.bin \
  --message-type RAW --signing-algorithm ECDSA_SHA_256 \
  --output text --query Signature | base64 -d > sig.der
```

Raw `r‖s` and DER are both accepted, as binary, base64 or hex — devices do
not agree on any of this, so the next step works it out instead of asking.

### 3 — Assemble, which refuses to be wrong

```bash
node packages/attest-sign/src/cli.ts assemble \
  --statement prepared.json --signature sig.der --out signed.json
```

The signature is verified against the public key in the statement **before
anything is written**. A device that signed the wrong bytes, or with a
different key than its alias suggested, fails here — in front of the
operator — rather than months later in front of a recipient. What comes out
is a complete signed statement: paste it into the console, or send it as
`{ "statement": … }` to `POST /v1/attestations/signed`.

## What gets signed

```
"stonehash:attestation:sig:v1\n" ‖ JCS(statement without its signature)
```

`JCS` is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON.
The domain separator means a signature made here can never be replayed as a
signature over anything else this system hashes.

**Use the SDK rather than reimplementing this.** A canonicaliser that orders a
key differently, or formats a number differently, produces a signature that
fails verification with no diagnostic worth reading. The SDK does not
reimplement it either — it imports the same module the verifier uses, so the
signer and the checker cannot drift.

## What the chain commits to

```
leaf_bytes = sha256(JCS(statement *including* its signature))
```

Note the asymmetry. Signing covers the statement **without** the signature;
anchoring covers it **with**. That is what timestamps the signature: one block
height then proves the document existed, that you signed it, and that both
were true by that block.

It costs nothing extra. The signed record joins the same batch as every other
record — no extra on-chain data, no separate transaction, same fee.

What the chain does *not* carry is the statement text, only its hash. Keep
your proof file: it is the readable copy, and it has no expiry.

## Registered keys, and what a signature does not prove

A statement carries its own public key, so a valid signature proves that
**the holder of that key** signed — not whose key it is. Anyone can generate
one.

Registering the public half with us is what closes that. Afterwards, records
signed by it report:

| `issuer_trust` | Means |
|---|---|
| `registered` | The key is one your organisation vouched for, before this record was made. |
| `unregistered` | The signature is arithmetically sound and establishes nothing about whose key it is. |

`unregistered` is **not a weaker `registered`**. It is a different statement,
and the console reports it as such rather than showing a tick.

Revoking a key changes how *future* records are reported. Records already
anchored keep the trust they had when they were made — a proof states what was
true at its block height, and rewriting that retroactively would make the
record say something it did not say.

Registration happens in the console under **Integrate → Signing public keys ·
institutions**, by a person who is signed in, or from your own server with
`POST /v1/issuer-keys`. Either way only the public half is
sent: vouching for a key is a governance act, and the private key never
leaves you.

## Algorithms

`ES256` (P-256) is the default: it is what WebCrypto, WebAuthn and most KMS
products speak, and its signatures are 64 bytes.

`RS256` is accepted because banks have RSA keys in hardware they cannot
replace to suit us. One caveat: a browser withholds WebCrypto outside a secure
context, and the pure-JavaScript fallback in the verifier covers P-256 only —
so checking an RSA signature in a browser needs the page served over HTTPS.
Server-side verification is unaffected.
