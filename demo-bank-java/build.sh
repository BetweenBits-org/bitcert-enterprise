#!/usr/bin/env bash
# Compiles the demo against the Java SDK's released jar. Needs a JDK 11 or newer and a
# release of the SDK (attest/sdks/attest-remit-java/release.sh).
#
# The demo keeps its own copy of the jar in lib/, so the running service is not
# touched when the SDK is rebuilt; restart it (pm2 restart stonehash-bank-java)
# after this script to pick a new build up.
set -euo pipefail
cd "$(dirname "$0")"
JAR="../attest/sdks/attest-remit-java/release/stonehash-attest-remit-0.1.0.jar"
test -f "$JAR" || { echo "release the SDK first: ../attest/sdks/attest-remit-java/release.sh" >&2; exit 1; }
# Built beside what is running and renamed into place: a JVM that has the old jar
# open keeps reading the old file, instead of finding a half-written one under it.
rm -rf build.next && mkdir -p build.next lib
javac --release 11 -Xlint:all -encoding UTF-8 -cp "$JAR" -d build.next src/*.java
cp "$JAR" lib/.next.jar && mv lib/.next.jar "lib/$(basename "$JAR")"
rm -rf build.previous
if [ -d build ]; then mv build build.previous; fi
mv build.next build
rm -rf build.previous
echo "built demo-bank-java (run: java -cp lib/stonehash-attest-remit-0.1.0.jar:build BankDemo)"
