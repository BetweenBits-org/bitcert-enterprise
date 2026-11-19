#!/usr/bin/env bash
# Builds the library jar, its sources jar and the example program.
# Needs a JDK 11 or newer (javac, jar) and nothing else.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=0.1.0
JAR="dist/stonehash-attest-por-$VERSION.jar"

rm -rf build/classes build/examples dist
mkdir -p build/classes build/examples dist

javac --release 11 -Xlint:all -encoding UTF-8 -d build/classes $(find src/main/java -name '*.java' | sort)

cat > build/MANIFEST.MF <<MANIFEST
Implementation-Title: StoneHash Attest proof of reserves SDK
Implementation-Version: $VERSION
Implementation-Vendor: StoneHash
Automatic-Module-Name: com.stonehash.attest.por
MANIFEST
jar --create --file "$JAR" --manifest build/MANIFEST.MF -C build/classes .
jar --create --file "dist/stonehash-attest-por-$VERSION-sources.jar" -C src/main/java .

# The example is compiled against the jar, as a customer's code would be.
javac --release 11 -Xlint:all -encoding UTF-8 -cp "$JAR" -d build/examples examples/PorExample.java

echo "built $JAR"
