# Overview

StoneHash Attest hashes a record, commits the digest to Bitcoin, and hands the
holder a proof file that anyone can check without contacting us. This page is
the map: what the service proves, the three products and where their guides
are, which environment you are on, and how calls are authenticated.

A bank integrating settlement can start straight at
[Cross-border Settlement](#corridor): your own system's source calls the
SDK, which turns the MT103 or ISO 20022 message your payment system already
writes into a signed instruction.

## What this proves

- **Anchoring sends a digest, not the document.** You hash the record on your
  own machine and submit the SHA-256. The one route that takes the document
  itself is the explicit full-document option, which writes it into a public
  Bitcoin transaction — see [Security & Privacy](#security).
- **The proof file is self-contained.** Given it and any public view of
  Bitcoin, anyone can confirm the record without contacting StoneHash. Free-tier
  records expire after the retention window `/v1/meta` reports; your
  organisation's records, from an API key or the console, have no expiry and
  are kept until you ask for them to be deleted. The file you downloaded keeps
  verifying either way.
- **The arithmetic checks run offline.** Document match, batch inclusion and
  transaction binding verify with no network and no trust in StoneHash.
  **Chain inclusion is yours to confirm**, through any Bitcoin source you
  choose — until you do, the report reads `skip`, which means unverified, not
  fine.

## Three products

| Product | For | Start with |
|---|---|---|
| **Attest Core** | companies anchoring documents and records | [Quick Start](#quickstart), then [Issuer Signing](#signing) if records should carry your signature |
| **Cross-border Settlement** | banks and remitters on stablecoin rails | [Cross-border Settlement](#corridor) — the bank SDK you call from your own system's source; it turns the MT103 or ISO 20022 message your system already writes into a signed instruction |
| **Proof of Reserves** | exchanges publishing recurring reserve proofs | [Proof of Reserves](#por) — the exchange SDK and the public verification page |

Anchors issued by Settlement and Proof of Reserves are included in those
products and never draw on the Attest quota. A product is activated under
**Subscriptions** in the [Sandbox Console](../console/), which is also where
API keys and signing keys are managed.

## Environments

Sandbox and production run the same request-handling code. They differ in
which database is opened, which anchor backend is constructed and which key
prefix authenticates, plus the facilities only a sandbox has — the self-serve
console and terminal key minting. `GET /v1/meta` tells you which deployment
you are talking to.

This sandbox anchors to a private **regtest** chain. The proof's arithmetic
checks verify here exactly as they would on mainnet, but chain inclusion cannot
be confirmed by a third party, because we mine the blocks: a regtest proof is a
faithful exercise of the whole pipeline and not a publicly verifiable proof. A
live deployment anchors to public Bitcoin; access to one is arranged with us,
and the console you are using is sandbox-only.

## Authentication

| Level | Routes | How |
|---|---|---|
| **No key** | `GET /v1/meta`, the free tier (`POST /v1/public/anchors`), `POST /v1/sandbox/keys` | Nothing. The free tier is capped per address and service-wide and answers `429` with a `retry-after` header. |
| **Bearer key** | `/v1/attestations`, `/v1/settlements`, `/v1/por`, `/v1/issuer-keys` and the rest of the keyed API | `Authorization: Bearer sk_test_…` in sandbox, `sk_live_…` in production — the prefix is part of the key. Issued under **Integrate → API keys** in the console, or `POST /v1/sandbox/keys` from a terminal creates a new sandbox organisation with its first key; shown once, only its hash is stored; several can be live at once, each with a label. |
| **Console session** | `/v1/console/*` | The console's own cookie, sandbox-only. The keyed routes accept it as well in the sandbox, so the console can exercise the same routes you integrate against; `/v1/console/*` takes only the cookie. |

Signing keys are not API keys: an ES256 pair whose private half stays with
you and whose public half is registered and chosen at product activation —
see [Issuer Signing](#signing). The [API Reference](#api) reads in both
languages — its paths, fields, codes and examples exist once, and only the prose
is translated, beside the English in the same file. The
[Evidence Specification](#spec) is English-only on purpose: it is the contract
an implementation must match byte for byte, and a translated contract is a
second normative text.
