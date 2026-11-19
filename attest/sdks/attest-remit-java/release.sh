#!/usr/bin/env bash
# Cuts a release: builds, runs every test, and only then replaces release/ with
# the jar, its sources jar and a pom for publishing it to an internal repository.
#
# release/ is what the developer hub's download packs and what the demos copy
# from. build.sh and run-tests.sh rebuild dist/ every time they run; release/
# changes only here, and only when the tests pass.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=0.1.0
NAME="stonehash-attest-remit-$VERSION"

./run-tests.sh

STAGE="build/release"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp "dist/$NAME.jar" "dist/$NAME-sources.jar" "$STAGE/"
cat > "$STAGE/$NAME.pom" <<POM
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.stonehash</groupId>
  <artifactId>stonehash-attest-remit</artifactId>
  <version>$VERSION</version>
  <packaging>jar</packaging>
  <name>StoneHash Attest cross-border settlement SDK</name>
  <description>The bank's side of the StoneHash Attest settlement corridor: SWIFT messages in, signed payment instructions out, status back as pacs.002. Java 11 or later, no dependencies.</description>
</project>
POM
(cd "$STAGE" && sha256sum "$NAME.jar" "$NAME-sources.jar" "$NAME.pom" > SHA256SUMS)

# Swapped in whole, so a reader never finds half a release.
rm -rf release.previous
if [ -d release ]; then mv release release.previous; fi
mv "$STAGE" release
rm -rf release.previous
echo "released release/$NAME.jar"
cat release/SHA256SUMS
