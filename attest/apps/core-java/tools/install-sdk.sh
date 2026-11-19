#!/bin/sh
# Installs the bank SDK jar this build depends on into the local Maven
# repository — after checking that it is the release this build is pinned to.
#
#   apps/core-java/tools/install-sdk.sh
#
# The SDK (sdks/attest-remit-java) is not a Maven project: it is built with
# javac alone, for Java 11, with no dependency. Its release directory holds
# the jar, the sources, a pom and their SHA-256. The back end depends on it
# for the bytes both sides must agree on (canonical JSON, signing input,
# rules); it never copies its sources. apps/core-java/sdk.lock names the
# release: a new SDK release is adopted by changing that line, in the same
# change that needs it.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REL="$HERE/../../../sdks/attest-remit-java/release"
JAR=stonehash-attest-remit-0.1.0
( cd "$REL" && sha256sum -c SHA256SUMS >/dev/null ) || { echo "the SDK release does not match its own SHA256SUMS" >&2; exit 1; }
want=$(cut -d' ' -f1 "$HERE/../sdk.lock")
have=$(sha256sum "$REL/$JAR.jar" | cut -d' ' -f1)
if [ "$want" != "$have" ]; then
  echo "the SDK release on disk is $have; this build is pinned to $want (apps/core-java/sdk.lock)" >&2
  exit 1
fi
cd "$HERE/.."
./mvnw -B -q install:install-file -Dfile="$REL/$JAR.jar" -DpomFile="$REL/$JAR.pom" -Dsources="$REL/$JAR-sources.jar"
echo "installed com.stonehash:stonehash-attest-remit:0.1.0 ($have)"
