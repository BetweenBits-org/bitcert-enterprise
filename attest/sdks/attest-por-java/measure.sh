#!/usr/bin/env bash
# Measures build time and peak memory from in-memory rows through tree construction.
#   ./measure.sh 100000 3            accounts, assets
#   POR_HEAP=512m ./measure.sh 300000 3
# One run at a time: the peak memory reported is that of the whole process (GNU time, "Maximum resident set size").
set -euo pipefail
cd "$(dirname "$0")"

JAR="dist/stonehash-attest-por-0.1.0.jar"
[ -f "$JAR" ] || ./build.sh >&2
mkdir -p build/tools
javac --release 11 -encoding UTF-8 -cp "$JAR" -d build/tools tools/MeasureBuild.java

/usr/bin/time -v java "-Xmx${POR_HEAP:-2g}" -cp "$JAR:build/tools" MeasureBuild "${1:?accounts}" "${2:-3}" 2> build/tools/time.txt
grep -E "Maximum resident set size|Elapsed \(wall clock\)" build/tools/time.txt
