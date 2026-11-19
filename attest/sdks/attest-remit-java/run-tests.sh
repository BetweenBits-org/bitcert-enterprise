#!/usr/bin/env bash
# Builds everything and runs the tests. Exits non-zero when any test fails.
#   ./run-tests.sh                 every test
#   ./run-tests.sh SigningTest     the tests whose name contains "SigningTest"
# Every class under src/test/java whose name ends in "Test" is run; there is no list to add a class to.
set -euo pipefail
cd "$(dirname "$0")"

JAR="dist/stonehash-attest-remit-0.1.0.jar"

./build.sh

rm -rf build/test-classes
mkdir -p build/test-classes
# The tests are compiled against the jar, so what is tested is what ships.
javac --release 11 -Xlint:all -encoding UTF-8 -cp "$JAR" -d build/test-classes $(find src/test/java -name '*.java' | sort)

# The Spring examples are compiled too, so that a change to the SDK's API cannot leave
# them behind: against stand-ins for the few Spring types they use, or against the real
# framework when SPRING_CLASSPATH names its jars.
if ls examples/spring/*.java >/dev/null 2>&1; then
  rm -rf build/spring-stubs build/spring-examples
  mkdir -p build/spring-stubs build/spring-examples
  if [ -n "${SPRING_CLASSPATH:-}" ]; then
    SPRING="$SPRING_CLASSPATH"
  else
    javac --release 11 -encoding UTF-8 -d build/spring-stubs $(find src/test/stubs -name '*.java' | sort)
    SPRING="build/spring-stubs"
  fi
  javac --release 11 -Xlint:all -encoding UTF-8 -cp "$JAR:$SPRING" -d build/spring-examples examples/spring/*.java
fi

java -cp "$JAR:build/test-classes" com.stonehash.attest.remit.TestMain build/test-classes src/test/resources "${1:-}"
