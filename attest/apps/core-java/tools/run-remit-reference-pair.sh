#!/usr/bin/env bash
# The settlement rail's comparison proved against the reference alone: TWO reference cores on two schemas seeded
# identically, each with its own partner stand-in listener, one stand-in chain node — and the comparison cases
# (parity/run.mjs) and the flow comparison (tools/remit-flows.mjs, tools/compare-remit-flows.mjs) run with both
# addresses pointing at reference cores. Whatever differs there is not a difference between two services: it is
# a value a case did not name as changing from run to run, or a race a case depends on — to be fixed in the case.
#
#   apps/core-java/tools/run-remit-reference-pair.sh <log dir> [--no-seed] [--flows] [--no-cases] [-- <arguments for parity/run.mjs>]
#
#   --no-seed    use the two schemas as they are (a second look at cases that change nothing; everything else
#                wants a fresh seed: seeded settlements are carried on once)
#   --flows      after the cases, run the scripted flows against each core and compare the two ledgers
#   --no-cases   skip parity/run.mjs (with --flows: the flows alone)
#
# Its own ports and schemas, never the comparison pair's: the ports are the ones the two settings files give
# (tools/test-ports.mjs on .env.rref-a and .env.rref-b) — in the main working copy reference cores :8794
# (stonehash_test_remit_a) and :8795 (stonehash_test_remit_b), stand-in chain node :8796, partner listeners :3311
# and :3312; another working copy of the repository has settings files, ports and schemas of its own (the script
# prints the ones it uses). Seed file parity/seed.rref.json. It refuses
# to start when one of the ports is taken, stops only what it started, by process id, and says at the end whether
# the ports are free. In the comparison's words the first core is "the reference" and the second stands where the
# Java server will.
#
# Exit status: 0 when nothing differed and nothing is left running.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ATTEST="$(cd "$HERE/../../.." && pwd)"
J=apps/core-java
ports="$(cd "$ATTEST" && node $J/tools/test-ports.mjs $J/.env.rref-a $J/.env.rref-b)" || exit 2
eval "$ports"   # REF_PORT: the first core, JAVA_PORT: the second, NODE_PORT, PARTNER_REF_PORT, PARTNER_JAVA_PORT
PORTS="$REF_PORT $JAVA_PORT $NODE_PORT $PARTNER_REF_PORT $PARTNER_JAVA_PORT"
A=http://127.0.0.1:$REF_PORT; B=http://127.0.0.1:$JAVA_PORT; PA=http://127.0.0.1:$PARTNER_REF_PORT; PB=http://127.0.0.1:$PARTNER_JAVA_PORT
NODE=http://127.0.0.1:$NODE_PORT

LOG="${1:?usage: run-remit-reference-pair.sh <log dir> [--no-seed] [--flows] [--no-cases] [-- run.mjs arguments]}"; shift
SEED=1; FLOWS=0; CASES=1; RUN_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-seed) SEED=0; shift ;;
    --flows) FLOWS=1; shift ;;
    --no-cases) CASES=0; shift ;;
    --) shift; RUN_ARGS=("$@"); break ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$LOG"; LOG="$(cd "$LOG" && pwd)"

taken() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"; }
for port in $PORTS; do
  if taken "$port"; then echo "port $port is taken — another run is in progress, or a process was left behind" >&2; exit 2; fi
done
cd "$ATTEST"
node $J/tools/check-test-env.mjs $J/.env.rref-a $J/.env.rref-b || exit 2

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

if [ $SEED -eq 1 ]; then
  step "seed both schemas (the first through the reference's code, copied to the second; seed file parity/seed.rref.json)"
  # The copy needs the second schema's tables. In a new working copy nobody has made them: the reference's own, once.
  node $J/tools/reference-tables.mjs $J/.env.rref-b > "$LOG/tables.log" 2>&1 \
    || { echo "the second schema could not be given the reference's tables:"; tail -5 "$LOG/tables.log"; exit 1; }
  tail -1 "$LOG/tables.log"
  PARITY_SEED_OUT=$J/parity/seed.rref.json nice node $J/tools/seed-reference.mjs $J/.env.rref-a $J/.env.rref-b > "$LOG/seed.log" 2>&1 \
    || { echo "seeding failed:"; tail -20 "$LOG/seed.log"; exit 1; }
  tail -2 "$LOG/seed.log" | cut -c1-500
fi

step "stand-in chain node (:$NODE_PORT), partner stand-in (:$PARTNER_REF_PORT for the first core, :$PARTNER_JAVA_PORT for the second), two reference cores (:$REF_PORT, :$JAVA_PORT)"
node $J/tools/stand-in-eth-rpc.mjs --port "$NODE_PORT" > "$LOG/chain.log" 2>&1 &
PIDS+=($!)
node $J/tools/stand-in-partner.mjs --listen "$PARTNER_REF_PORT=$A" --listen "$PARTNER_JAVA_PORT=$B" --seed $J/parity/seed.rref.json > "$LOG/partner.log" 2>&1 &
PIDS+=($!)
nice node $J/tools/run-reference-core.mjs $J/.env.rref-a > "$LOG/core-a.log" 2>&1 &
PIDS+=($!)
nice node $J/tools/run-reference-core.mjs $J/.env.rref-b > "$LOG/core-b.log" 2>&1 &
PIDS+=($!)
ready=0
for _ in $(seq 1 120); do
  if curl -fsS -m 2 $A/healthz >/dev/null 2>&1 && curl -fsS -m 2 $B/healthz >/dev/null 2>&1 && curl -fsS -m 2 $NODE/log/summary >/dev/null 2>&1 \
     && curl -fsS -m 2 $PA/healthz >/dev/null 2>&1 && curl -fsS -m 2 $PB/healthz >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ $ready -ne 1 ]; then echo "they did not come up:"; tail -5 "$LOG"/core-a.log "$LOG"/core-b.log "$LOG"/partner.log "$LOG"/chain.log; exit 1; fi
echo "all five answer"

if [ $CASES -eq 1 ]; then
  step "responses (parity/run.mjs ${RUN_ARGS[*]:-}), both addresses at reference cores"
  node $J/parity/run.mjs --ref $A --java $B --seed $J/parity/seed.rref.json --ref-env $J/.env.rref-a --java-env $J/.env.rref-b \
    --partner-ref $PA --partner-java $PB "${RUN_ARGS[@]}" > "$LOG/run.log" 2>&1; rc=$?
  grep -cE '^(DIFF|FAIL)' "$LOG/run.log" | sed 's/^/DIFF and FAIL lines: /'
  tail -3 "$LOG/run.log" | cut -c1-400; echo "exit $rc"; [ $rc -eq 0 ] || status=1

  step "what the stand-ins were asked"
  curl -sS -m 5 $NODE/log/summary > "$LOG/chain-summary.json" 2>&1
  head -c 300 "$LOG/chain-summary.json"; echo
  curl -sS -m 10 "$PA/log/compare?with=$PARTNER_JAVA_PORT" > "$LOG/partner-compare.json" 2>&1
  tr -d '\n' < "$LOG/partner-compare.json" | head -c 900; echo
  curl -sS -m 10 $PA/log/summary > "$LOG/partner-a.json" 2>&1
  curl -sS -m 10 $PB/log/summary > "$LOG/partner-b.json" 2>&1
  grep -q '"same": *true' "$LOG/partner-compare.json" || { echo "the two cores did not ask their partners the same"; status=1; }
fi

if [ $FLOWS -eq 1 ]; then
  step "the scripted flows, against each core"
  nice node $J/tools/remit-flows.mjs --core $A --partner $PA --env $J/.env.rref-a --out "$LOG/flows-a.json" > "$LOG/flows-a.log" 2>&1; rc=$?
  tail -2 "$LOG/flows-a.log" | cut -c1-400; echo "exit $rc"; [ $rc -eq 0 ] || status=1
  nice node $J/tools/remit-flows.mjs --core $B --partner $PB --env $J/.env.rref-b --out "$LOG/flows-b.json" > "$LOG/flows-b.log" 2>&1; rc=$?
  tail -2 "$LOG/flows-b.log" | cut -c1-400; echo "exit $rc"; [ $rc -eq 0 ] || status=1
  step "the two ledgers, scenario by scenario (nothing is expected to differ between two reference cores)"
  node $J/tools/compare-remit-flows.mjs "$LOG/flows-a.json" "$LOG/flows-b.json" --expected none > "$LOG/flows-compare.log" 2>&1; rc=$?
  tail -4 "$LOG/flows-compare.log" | cut -c1-400; echo "exit $rc"; [ $rc -eq 0 ] || status=1
fi

step "stop what was started"
stop_all
left=0
for port in $PORTS; do
  if taken "$port"; then echo "port $port is still taken"; status=1; left=1; fi
done
[ $left -eq 0 ] && echo "ports $PORTS are free"

echo; echo "== overall status $status"
exit $status
