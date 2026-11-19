# attest-sign — issuer signing, packaged so a bank's change process can accept it.
#
# ## Why an image at all
#
# The library is the real artifact; this is packaging. It exists because the
# customers who most need to hold their own key are the ones least able to
# `npm install` on the machine that will hold it. A vetted image they can load
# onto an offline host clears a change-control process that an npm package
# does not.
#
# ## Why you can trust it with a key — and how to check
#
# A container that generates private keys is exactly the thing you should not
# take on faith, so nothing here asks you to:
#
#   * **It is this repository's source, unmodified.** No build step, no
#     bundler, no minifier. `docker run --rm --entrypoint cat … /app/src/index.ts`
#     prints the same file you can read on disk.
#   * **Reproducible.** The base is pinned by digest and the image contains
#     only copied files, so two builds of the same commit produce the same
#     image digest. Rebuild it yourself and compare rather than trusting ours.
#   * **It cannot phone home.** Run it with `--network=none`. The code opens
#     no sockets (a test asserts that), and `--offline-check` makes the tool
#     refuse to run if a network *is* reachable.
#   * **It writes the key only where you mount.** The private key goes to the
#     path you pass to `--out`, inside your bind mount, and nowhere else.
#
# ## Build
#
#   docker build -t stonehash/attest-sign:0.1.0 \
#     -f packages/attest-sign/Dockerfile .
#
# (Context is the repo root: the SDK imports the canonicaliser from
# `attest-verify`, and shipping a second copy of it is how the two would
# eventually disagree.)
#
# ## Use
#
#   docker run --rm --network=none -v "$PWD:/work" stonehash/attest-sign \
#     keygen --out /work/issuer.key.json
#
#   docker run --rm --network=none -v "$PWD:/work" stonehash/attest-sign \
#     sign --key /work/issuer.key.json --statement /work/statement.json
#
# Node 22 on Alpine, pinned by digest. Update the digest deliberately — a
# floating tag would make the "reproducible" claim above untrue.
FROM node:22.11.0-alpine3.20@sha256:b64ced2e7cd0a4816699fe308ce6e8a08ccba463c757c00c14cd372e3d2c763e

# No package manager, no network, no install step. The runtime dependency
# count is zero by design, so there is nothing to fetch and nothing whose
# registry could be compromised between our build and yours.
WORKDIR /app
COPY packages/attest-sign/src            /app/src
COPY packages/attest-sign/package.json   /app/package.json
COPY packages/attest-verify/src          /app/vendor/attest-verify/src
COPY packages/attest-verify/package.json /app/vendor/attest-verify/package.json

# The verifier lives outside `node_modules` and is reached through a symlink.
#
# Node refuses to strip types from files under `node_modules` — deliberately,
# and not overridable. Resolution follows the symlink to its real path, which
# is `/app/vendor/...`, so the sources stay runnable as TypeScript and the
# image stays byte-for-byte the code in the repository. Copying built `.js`
# instead would work and would quietly break the claim above that what runs
# here is what you can read.
RUN mkdir -p /app/node_modules/@stonehash \
 && ln -s /app/vendor/attest-verify /app/node_modules/@stonehash/attest-verify

# Unprivileged, and with no home directory to accumulate state. The image is
# read-only in practice: everything it produces lands in the caller's mount.
USER node

# `--experimental-strip-types` lets Node run the .ts sources directly, which
# is what keeps "the image is the source you can read" literally true.
ENTRYPOINT ["node", "--experimental-strip-types", "--no-warnings", "/app/src/cli.ts"]
CMD ["--help"]

LABEL org.opencontainers.image.title="attest-sign" \
      org.opencontainers.image.description="Generate an issuer key and sign StoneHash Attest statements. Makes no network calls." \
      org.opencontainers.image.licenses="MIT" \
