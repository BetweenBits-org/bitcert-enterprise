# Stand-ins for the Spring types the examples use

`examples/spring/` shows the SDK inside a Spring service. The SDK itself has no
dependency, and its tests must not need one either, so the handful of Spring
annotations and classes those examples touch are declared here with the same
names and shapes. `run-tests.sh` compiles the examples against the SDK's jar
and these — which is what keeps an example from going stale when the SDK's
API changes.

They are not Spring and are never shipped in the jar. To compile the examples
against the real framework instead, set `SPRING_CLASSPATH` to its jars when
running `run-tests.sh`.
