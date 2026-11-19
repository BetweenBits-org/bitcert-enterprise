#!/usr/bin/env bash
# The whole response comparison of parity/README.md in one go: stand-in chain node, seed, both servers,
# the comparisons, and everything it started stopped again — also when a step fails.
#
#   apps/core-java/tools/run-parity.sh <log dir> [--sealing] [-- <arguments for parity/run.mjs>]
#
#   --sealing   after the servers are down, also let each side seal what the run left and compare
#               (tools/compare-por-sealing.mjs). Both schemas stay sealed: seed again before the next run.
#
# The ports are the ones the two settings files give (tools/test-ports.mjs) — here 8790 Java, 8791 reference,
# 8793 stand-in node, 3301 and 3302 the partner stand-in's two listeners, one for each server; another working
# copy of the repository has settings files, ports and schemas of its own. It refuses to start when one of its
# ports is taken: somebody else's run is in progress, or a server was left behind. It stops only the processes it started, by their process ids.
# The jar must have been built (./mvnw -o clean package).
#
# Exit status: 0 when every comparison passed and nothing is left running.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ATTEST="$(cd "$HERE/../../.." && pwd)"
JAVA=/usr/lib/jvm/java-17-openjdk-amd64/bin/java
JAR="$ATTEST/apps/core-java/target/stonehash-attest-core-0.1.0.jar"

LOG="${1:?usage: run-parity.sh <log dir> [--sealing] [-- run.mjs arguments]}"; shift
SEALING=0; RUN_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --sealing) SEALING=1; shift ;;
    --) shift; RUN_ARGS=("$@"); break ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$LOG"
[ -f "$JAR" ] || { echo "no jar at $JAR — build first" >&2; exit 2; }

ports="$(cd "$ATTEST" && node apps/core-java/tools/test-ports.mjs apps/core-java/.env.ref apps/core-java/.env.parity)" || exit 2
eval "$ports"
ALL_PORTS="$JAVA_PORT $REF_PORT $NODE_PORT $PARTNER_JAVA_PORT $PARTNER_REF_PORT"

taken() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"; }
for port in $ALL_PORTS; do
  if taken "$port"; then echo "port $port is taken — another run is in progress, or a server was left behind" >&2; exit 2; fi
done

# Neither server may be able to reach anything live (schema, wallet, partner simulator, chain node).
(cd "$ATTEST" && node apps/core-java/tools/check-test-env.mjs apps/core-java/.env.ref apps/core-java/.env.parity) || exit 2

PIDS=()
stop_all() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  for _ in $(seq 1 40); do
    alive=0; for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1; done
    [ $alive -eq 0 ] && break; sleep 0.25
  done
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null; done
  PIDS=()
}
trap stop_all EXIT

status=0
step() { echo; echo "== $*"; }
cd "$ATTEST"

step "stand-in chain node (:$NODE_PORT)"
node apps/core-java/tools/stand-in-eth-rpc.mjs --port "$NODE_PORT" > "$LOG/stand-in.log" 2>&1 &
PIDS+=($!)

# Each server has a partner of its own (REMIT_PARTNERS_BASE of its env file): one process, two listeners, each
# with its own state and log, each calling back its own server only. Control and the webhook receiver are paths
# on each listener (/control/…, /hooks/…).
step "stand-in partner (:$PARTNER_JAVA_PORT for the Java server, :$PARTNER_REF_PORT for the reference)"
node apps/core-java/tools/stand-in-partner.mjs --listen "$PARTNER_JAVA_PORT=http://127.0.0.1:$JAVA_PORT" --listen "$PARTNER_REF_PORT=http://127.0.0.1:$REF_PORT" > "$LOG/stand-in-partner.log" 2>&1 &
PIDS+=($!)

step "seed both schemas"
node apps/core-java/tools/seed-reference.mjs apps/core-java/.env.ref apps/core-java/.env.parity > "$LOG/seed.log" 2>&1 \
  || { echo "seeding failed:"; tail -20 "$LOG/seed.log"; exit 1; }
tail -3 "$LOG/seed.log"

step "Java: backfill-snapshot-keys (S-16)"
(cd apps/core-java && "$JAVA" -jar "$JAR" --env-file=.env.parity backfill-snapshot-keys) > "$LOG/backfill.log" 2>&1 \
  || { echo "backfill failed:"; tail -20 "$LOG/backfill.log"; exit 1; }
tail -1 "$LOG/backfill.log"

step "start the reference (:$REF_PORT) and the Java server (:$JAVA_PORT)"
node apps/core-java/tools/run-reference-core.mjs apps/core-java/.env.ref > "$LOG/reference.log" 2>&1 &
PIDS+=($!)
(cd apps/core-java && exec "$JAVA" -jar "$JAR" --env-file=.env.parity serve) > "$LOG/java.log" 2>&1 &
PIDS+=($!)
ready=0
for _ in $(seq 1 120); do
  if curl -fsS -m 2 "http://127.0.0.1:$JAVA_PORT/healthz" >/dev/null 2>&1 && curl -fsS -m 2 "http://127.0.0.1:$REF_PORT/healthz" >/dev/null 2>&1 \
     && curl -fsS -m 2 "http://127.0.0.1:$NODE_PORT/log/summary" >/dev/null 2>&1 \
     && curl -fsS -m 2 "http://127.0.0.1:$PARTNER_JAVA_PORT/healthz" >/dev/null 2>&1 && curl -fsS -m 2 "http://127.0.0.1:$PARTNER_REF_PORT/healthz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ $ready -ne 1 ]; then
  echo "the servers did not come up:"; tail -5 "$LOG/reference.log"; tail -5 "$LOG/java.log"; tail -5 "$LOG/stand-in.log"; tail -5 "$LOG/stand-in-partner.log"; exit 1
fi
echo "all five answer (two servers, the stand-in node, the partner stand-in's two listeners)"

step "responses (parity/run.mjs ${RUN_ARGS[*]:-})"
node apps/core-java/parity/run.mjs --ref "http://127.0.0.1:$REF_PORT" --java "http://127.0.0.1:$JAVA_PORT" \
  --partner-ref "http://127.0.0.1:$PARTNER_REF_PORT" --partner-java "http://127.0.0.1:$PARTNER_JAVA_PORT" \
  "${RUN_ARGS[@]}" > "$LOG/run.log" 2>&1; rc=$?
tail -6 "$LOG/run.log"; echo "exit $rc"; [ $rc -eq 0 ] || status=1

if [ ${#RUN_ARGS[@]} -eq 0 ]; then
  step "audit rows"
  node apps/core-java/tools/compare-audit.mjs apps/core-java/.env.ref apps/core-java/.env.parity > "$LOG/audit.log" 2>&1; rc=$?
  tail -4 "$LOG/audit.log"; echo "exit $rc"; [ $rc -eq 0 ] || status=1

  step "institutions and subscriptions"
  node apps/core-java/tools/compare-registry.mjs apps/core-java/.env.ref apps/core-java/.env.parity > "$LOG/registry.log" 2>&1; rc=$?
  tail -4 "$LOG/registry.log"; echo "exit $rc"; [ $rc -eq 0 ] || status=1

  step "reserve snapshots"
  node apps/core-java/tools/compare-por.mjs apps/core-java/.env.ref apps/core-java/.env.parity > "$LOG/por.log" 2>&1; rc=$?
  tail -4 "$LOG/por.log"; echo "exit $rc"; [ $rc -eq 0 ] || status=1

  step "what the stand-in node was asked"
  curl -sS -m 5 "http://127.0.0.1:$NODE_PORT/log/summary" > "$LOG/stand-in-summary.json" 2>&1
  head -c 600 "$LOG/stand-in-summary.json"; echo
  grep -q '"same": *true' "$LOG/stand-in-summary.json" || { echo "the two services did not send the node the same requests"; status=1; }

  # Payment by payment: the same requests in the same order, the same answers given, the same callbacks sent.
  # The request headers (an Idempotency-Key from one server only) and the servers' answers to callbacks are
  # reported apart and do not decide: the response comparison above is where those are looked at.
  step "what the partner stand-ins were asked ($PARTNER_JAVA_PORT: the Java server's, $PARTNER_REF_PORT: the reference's)"
  curl -sS -m 10 "http://127.0.0.1:$PARTNER_JAVA_PORT/log/compare?with=$PARTNER_REF_PORT" > "$LOG/stand-in-partner-compare.json" 2>&1
  head -c 900 "$LOG/stand-in-partner-compare.json"; echo
  curl -sS -m 10 "http://127.0.0.1:$PARTNER_JAVA_PORT/log/summary" > "$LOG/stand-in-partner-java.json" 2>&1
  curl -sS -m 10 "http://127.0.0.1:$PARTNER_REF_PORT/log/summary" > "$LOG/stand-in-partner-reference.json" 2>&1
  grep -q '"same": *true' "$LOG/stand-in-partner-compare.json" || { echo "the two services did not ask their partners the same"; status=1; }
fi

step "stop what was started"
stop_all
left=0
for port in $ALL_PORTS; do
  if taken "$port"; then echo "port $port is still taken"; status=1; left=1; fi
done
[ $left -eq 0 ] && echo "ports $ALL_PORTS are free"

if [ $SEALING -eq 1 ]; then
  step "sealing of what the run left (no chain)"
  node apps/core-java/tools/compare-por-sealing.mjs apps/core-java/.env.ref-worker apps/core-java/.env.dev-worker > "$LOG/sealing.log" 2>&1; rc=$?
  tail -4 "$LOG/sealing.log"; echo "exit $rc"; [ $rc -eq 0 ] || status=1
fi

echo; echo "== overall status $status"
exit $status
