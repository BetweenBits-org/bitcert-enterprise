#!/usr/bin/env bash
# Builds everything and runs the tests. Exits non-zero when any test fails.
#   ./run-tests.sh                 every test
#   ./run-tests.sh ClientTest      the tests whose name contains "ClientTest"
# POR_VECTORS names the directory holding SPEC.md and the vectors when it is not ../../fixtures/por.
set -euo pipefail
cd "$(dirname "$0")"

VECTORS="${POR_VECTORS:-../../fixtures/por}"
JAR="dist/stonehash-attest-por-0.1.0.jar"

./build.sh

rm -rf build/test-classes
mkdir -p build/test-classes
# The tests share the library's package; they are compiled against the jar, so what is tested is what ships.
javac --release 11 -Xlint:all -encoding UTF-8 -cp "$JAR" -d build/test-classes $(find src/test/java -name '*.java' | sort)

java -cp "$JAR:build/examples:build/test-classes" com.stonehash.attest.por.TestMain "$VECTORS" "${1:-}"

# The launcher itself, once, the way a customer or a cross-language test starts it.
bin/por-example conformance --vectors "$VECTORS" > /dev/null
echo "bin/por-example conformance: ok"
