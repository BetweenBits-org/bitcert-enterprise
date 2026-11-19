#!/usr/bin/env bash
# The second demo set, end to end (verification plan E.1–E.3): the sandbox's two smoke scripts —
# deploy/smoke-remit.mjs and deploy/smoke-exceptions.mjs, byte for byte — run against a TEST core, on copies of
# the partner simulator and of the bank demo in a work folder outside the repository, on a mock chain, with
# nothing live in reach. One set at a time, from an emptied schema, and everything it started stopped again —
# also when a step fails.
#
#   apps/core-java/tools/run-second-set.sh ref  <work folder>     the reference TypeScript core (proves the arrangement)
#   apps/core-java/tools/run-second-set.sh java <work folder>     the Java core (the jar must have been built)
#   apps/core-java/tools/run-second-set.sh stop <work folder>     stop what an interrupted run left behind
#
#                     core                                    stand-in node   partner copy   bank copy
#   ref   :8782  .env.e2e-ref   stonehash_test_e2e_ref        :8783           :3304          :3202
#   java  :8781  .env.e2e-java  stonehash_test_e2e_java       :8783           :3303          :3201
#
# The work folder (it holds test keys only; made if absent, e.g. /tmp/attest-second-set):
#   <W>/attest/apps, <W>/attest/packages   links to the repository's (the copies import ../../attest/apps/core/src/remit/*.ts)
#   <W>/attest/deploy/smoke-*.mjs          byte copies; their SHA-256 is compared with the originals' on every run
#   <W>/runs/<set>-<time>/                 one run: demo-partners/ and demo-bank/ (the demos' program files, and the
#                                          folders the copies fill themselves), attest -> <W>/attest (so that
#                                          ../../attest resolves from the partner copy), logs/, home/
#   <W>/<set> -> runs/<set>-<time>         the run in progress, or the last one
#   <W>/demo-bank -> that run's demo-bank  so that smoke-remit.mjs, run from <W>/attest/deploy, finds the COPY's
#                                          identity at ../../demo-bank (the script has no setting for that folder)
#   <W>/core-java.jar                      (java) the jar the run used, copied so that a build cannot take it away
# Every run makes a folder of its own, and this script removes no folder: earlier runs stay under <W>/runs
# (about 1 MB each, test keys and logs) until somebody removes them by hand.
#
# What makes it safe (verification plan section F; each guard is marked F-n where it stands):
#   - every address a step uses is 127.0.0.1 on a port of this set; a live port (8787 3100 3200 3300 3400 3500
#     5106 8545 18443) is refused wherever a port is used, and so is any port that is not this set's;
#   - every process is started with an empty environment plus the variables written here, and WAITS AT A GATE
#     until check-second-set.mjs has read its environment, its command and its folder from /proc and found them
#     the set's own: a partner copy without CHAIN_BACKEND=mock, a demo copy or a setup.mjs without ATTEST_BASE,
#     a smoke script without its addresses never runs a single line;
#   - nothing in demo-partners/, demo-bank/, demo-customers/, demo-bank-java/ or attest/deploy/ is run, written
#     or edited: program files are copied out, state.json / keys / hsm / data / work never are;
#   - the processes are stopped by the process ids kept here (never by name), in reverse order; pm2, docker,
#     anvil, the live core and the live demos are not touched, and the times of the live folders' files are
#     compared before and after;
#   - the wallet is attest-java and no other; a second service with a worker on it refuses the start.
#
# Exit status: 0 both scripts passed, the extra checks passed, nothing is left running;
#              1 a step failed;  2 refused before anything was started;
#              3 (java) this build of the Java core does not have the settlement rail the scripts need;
#              4 files of the live folders changed while the set ran.
set -uo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd -P)"
MODULE="$(cd "$HERE/.." && pwd -P)"
ATTEST="$(cd "$HERE/../../.." && pwd -P)"
REPO="$(cd "$ATTEST/.." && pwd -P)"
CHECK="$HERE/check-second-set.mjs"
JAVA=/usr/lib/jvm/java-17-openjdk-amd64/bin/java
JAR="$MODULE/target/stonehash-attest-core-0.1.0.jar"
LIVE_PORTS="8787 3100 3200 3300 3400 3500 5106 8545 18443"
CHILD_PATH="/usr/local/bin:/usr/bin:/bin"
# The gate every process of the set waits at (check-second-set.mjs knows this text: GATE_SCRIPT).
GATE='read -r _ < "$1"; shift; exec "$@"'

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
refuse() { echo "refused: $*" >&2; exit 2; }
fail() { echo; echo "FAILED: $*"; exit 1; }
step() { echo; echo "== [$(date -u +%H:%M:%S) +${SECONDS}s] $*"; }

[ $# -eq 2 ] || usage
SET="$1"; W="$2"
case "$SET" in
  ref)  CORE_PORT=8782; PARTNER_PORT=3304; BANK_PORT=3202; ENV_NAME=.env.e2e-ref ;;
  java) CORE_PORT=8781; PARTNER_PORT=3303; BANK_PORT=3201; ENV_NAME=.env.e2e-java ;;
  stop) CORE_PORT=0; PARTNER_PORT=0; BANK_PORT=0; ENV_NAME= ;;
  *) usage ;;
esac
CHAIN_PORT=8783
ENV_FILE="$MODULE/$ENV_NAME"
OWN_PORTS="$CORE_PORT $CHAIN_PORT $PARTNER_PORT $BANK_PORT"
CORE="http://127.0.0.1:$CORE_PORT"
PARTNER="http://127.0.0.1:$PARTNER_PORT"
BANK="http://127.0.0.1:$BANK_PORT"
WEBHOOK="$BANK/api/remit/webhook"

# ── addresses ────────────────────────────────────────────────────────────────

taken() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"; }
# An address a step may use: 127.0.0.1, a port of this set, never a live port (F-2, F-4, F-5, F-6, F-7, F-18).
own_address() {
  local what="$1" v="$2" port p
  case "$v" in
    http://127.0.0.1:*) port="${v#http://127.0.0.1:}"; port="${port%%/*}" ;;
    *) refuse "$what is not an address on 127.0.0.1" ;;
  esac
  case "$port" in ''|*[!0-9]*) refuse "$what names no port" ;; esac
  for p in $LIVE_PORTS; do [ "$port" = "$p" ] && refuse "$what names the live port $p"; done
  case " $OWN_PORTS " in *" $port "*) ;; *) refuse "$what names port $port, which is not a port of this set" ;; esac
  return 0
}
# http <method> <url> [curl arguments…] — prints the status; the body goes to $LOGS/last-answer
http() {
  local method="$1" url="$2"; shift 2
  own_address "a request of this script" "$url" || return 1
  curl --noproxy '*' -sS -m 30 -o "$LOGS/last-answer" -w '%{http_code}' -X "$method" "$@" "$url" 2>/dev/null || echo 000
}
wait_http() { # wait_http <url> <seconds> — until it answers 200
  local url="$1" n="$2" i
  own_address "a request of this script" "$url"
  for i in $(seq 1 $((n * 2))); do
    [ "$(curl --noproxy '*' -s -m 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" = 200 ] && return 0
    sleep 0.5
  done
  return 1
}

# ── the processes this script starts: kept by process id and start time, stopped by them and nothing else (F-11) ─

PIDS=(); STARTS=(); PNAMES=()
# What /proc/<pid>/stat says after the command name, in ONE read: "<state> <start time>", or nothing when the
# process is gone. (Two reads can straddle the moment a dead process is collected, and then disagree.)
proc_look() {
  local stat rest; local -a f
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  [ -n "$stat" ] || return 1
  rest="${stat##*) }"; read -r -a f <<< "$rest"
  [ -n "${f[19]:-}" ] || return 1
  echo "${f[0]} ${f[19]}"
}
start_of() { local look; look="$(proc_look "$1")" || return 1; echo "${look#* }"; }
# Still the process this script started (a process id is given out again once its owner is gone), and not a corpse.
alive() {
  local look
  [ -n "$2" ] || return 1
  look="$(proc_look "$1")" || return 1
  [ "${look#* }" = "$2" ] && [ "${look%% *}" != Z ]
}
write_running() {
  local i; : > "$W/.running"
  for i in "${!PIDS[@]}"; do alive "${PIDS[$i]}" "${STARTS[$i]}" && printf '%s %s %s\n' "${PIDS[$i]}" "${STARTS[$i]}" "${PNAMES[$i]}" >> "$W/.running"; done
  return 0
}
remember() { PIDS+=("$1"); STARTS+=("$(start_of "$1")"); PNAMES+=("$2"); write_running; }
stop_one() { # stop_one <pid> <start time> <name>
  local pid="$1" start="$2" name="$3" i
  alive "$pid" "$start" || return 0
  kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 60); do alive "$pid" "$start" || break; sleep 0.25; done
  if alive "$pid" "$start"; then echo "   $name ($pid) did not end on TERM within 15 s — KILL"; kill -KILL "$pid" 2>/dev/null; sleep 0.5; fi
  wait "$pid" 2>/dev/null
  echo "   stopped $name ($pid)"
}
stop_all() {
  local i
  for ((i = ${#PIDS[@]} - 1; i >= 0; i--)); do stop_one "${PIDS[$i]}" "${STARTS[$i]}" "${PNAMES[$i]}"; done
  PIDS=(); STARTS=(); PNAMES=()
  rm -f -- "$W/.running"
}

# A tool of this module, with nothing of the caller's environment (F-9, F-20: no tool here falls back to a live setting).
tool() { env -i "PATH=$CHILD_PATH" "HOME=$R/home" "LANG=C.UTF-8" node "$@"; }

# start_gated <name> <role> <folder> [VAR=value …] -- <command …>
#   Starts the command in <folder> with an EMPTY environment plus the variables given, held at the gate; has
#   check-second-set.mjs read the waiting process's environment, command and folder; opens the gate only if
#   they are the set's own. The process id is in LAST_PID. The output goes to $LOGS/<name>.log.
LAST_PID=
start_gated() {
  local name="$1" role="$2" dir="$3"; shift 3
  local -a vars=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do vars+=("$1"); shift; done
  [ "${1:-}" = "--" ] || fail "start_gated $name: no command"
  shift
  local fifo="$LOGS/gate.$name"
  mkfifo "$fifo" || fail "could not make the gate of $name"
  ( cd "$dir" && exec env -i "PATH=$CHILD_PATH" "HOME=$R/home" "LANG=C.UTF-8" "${vars[@]}" \
      nice -n 10 bash -c "$GATE" gate "$fifo" "$@" ) > "$LOGS/$name.log" 2>&1 < /dev/null &
  LAST_PID=$!
  remember "$LAST_PID" "$name"
  if ! tool "$CHECK" --set "$SET" --work "$W" --env --gated "$role=$LAST_PID" > "$LOGS/env.$name.txt" 2>&1; then
    sed 's/^/   /' "$LOGS/env.$name.txt"
    fail "$name was NOT started: its environment, command or folder is not the set's own"
  fi
  sed -n 's/^ok    /   /p' "$LOGS/env.$name.txt"
  # the reader is waiting in open(); should it have died, do not wait for it for ever
  timeout 10 bash -c 'echo go > "$1"' _ "$fifo" || fail "$name ended before its gate was opened: $(tail -3 "$LOGS/$name.log")"
  rm -f -- "$fifo"
}
# run_gated <seconds> <name> <role> <folder> [VAR=value …] -- <command …> — the same, and waits for the end
run_gated() {
  local limit="$1"; shift
  local name="$1" i pid start rc
  start_gated "$@"
  pid="$LAST_PID"; start="${STARTS[-1]}"
  for i in $(seq 1 $((limit * 2))); do alive "$pid" "$start" || break; sleep 0.5; done
  if alive "$pid" "$start"; then stop_one "$pid" "$start" "$name"; write_running; echo "   $name did not end within ${limit} s"; return 124; fi
  wait "$pid"; rc=$?
  write_running
  return $rc
}

# ── stop: what an interrupted run left behind, by the process ids it kept ───

if [ "$SET" = stop ]; then
  [ -f "$W/.attest-second-set" ] || refuse "$W is not a work folder of this script"
  if [ -s "$W/.running" ]; then
    mapfile -t left < "$W/.running"
    for ((i = ${#left[@]} - 1; i >= 0; i--)); do
      read -r pid start name <<< "${left[$i]}"
      if alive "$pid" "$start"; then stop_one "$pid" "$start" "$name"; else echo "   $name ($pid) is gone already"; fi
    done
  else
    echo "no interrupted run is recorded in $W"
  fi
  rm -f -- "$W/.running"
  left_listening=0
  for port in 8781 8782 8783 3303 3304 3201 3202; do taken "$port" && { echo "port $port is still listening"; left_listening=1; }; done
  [ $left_listening -eq 0 ] && echo "ports 8781 8782 8783 3303 3304 3201 3202 are free"
  exit $left_listening
fi

# ── 1. checks — nothing is started before they pass ──────────────────────────

for p in $OWN_PORTS; do for l in $LIVE_PORTS; do [ "$p" = "$l" ] && refuse "this script's own table names the live port $l"; done; done
for u in "$CORE" "$PARTNER" "$BANK" "$WEBHOOK" "http://127.0.0.1:$CHAIN_PORT"; do own_address "an address of this set" "$u"; done
for c in node curl openssl flock sha256sum realpath ss mkfifo timeout; do command -v "$c" >/dev/null || refuse "$c is needed"; done
[ -n "$(PATH="$CHILD_PATH" command -v node)" ] || refuse "node is not in $CHILD_PATH"

# One run at a time: both sets anchor from the one wallet and share the stand-in node's port (F-12).
exec 9< "$HERE/run-second-set.sh"
flock -n 9 || refuse "another run of the second set is in progress (or left processes behind: run-second-set.sh stop <work folder>)"

# The work folder: absolute, a plain folder of ours, outside the repository (F-10) — decided before anything is made there.
case "$W" in /*) ;; *) refuse "the work folder must be an absolute path" ;; esac
case "$W" in *[[:space:]]*) refuse "the work folder's path must not contain white space" ;; esac
outside_repository() {
  case "$1/" in "$REPO"/*) refuse "the work folder is inside the repository — a demo copy beside the live folders reads their data" ;; esac
  case "$REPO/" in "$1"/*) refuse "the work folder contains the repository" ;; esac
  case "$1" in /|/tmp|/var/tmp|/home|"$HOME") refuse "$1 is not a folder to work in" ;; esac
  return 0
}
outside_repository "$(realpath -m -- "$W")"
if [ -e "$W" ] || [ -L "$W" ]; then
  { [ -d "$W" ] && [ ! -L "$W" ] && [ -O "$W" ]; } || refuse "$W is not a plain folder of this user"
  [ -f "$W/.attest-second-set" ] || [ -z "$(ls -A "$W")" ] || refuse "$W exists, is not empty and was not made by this script"
else
  mkdir -- "$W" || refuse "could not make $W"
fi
W="$(cd "$W" && pwd -P)"
outside_repository "$W"
: > "$W/.attest-second-set"

[ -s "$W/.running" ] && refuse "an interrupted run left processes behind — run: $0 stop $W"
for port in $OWN_PORTS; do
  taken "$port" && refuse "port $port is taken — another run is in progress, or a process was left behind"
done
# The exception matrix's manifest case compares one UTC day (demo-bank/remit.mjs:558): not across 00:00 UTC.
[ "$((10#$(date -u +%H%M)))" -ge 2345 ] && refuse "too close to 00:00 UTC — the manifest case must not straddle two days; start after midnight UTC"

R="$W/runs/$SET-$(date -u +%Y%m%dT%H%M%SZ)"   # this run's own folder
LOGS="$R/logs"
{ [ ! -e "$R" ] && mkdir -p "$LOGS" "$R/home"; } || refuse "could not make $R (a run was started in this very second?)"

echo "second demo set '$SET' — core :$CORE_PORT ($ENV_NAME), stand-in node :$CHAIN_PORT, partner copy :$PARTNER_PORT, bank copy :$BANK_PORT"
echo "work folder $W — this run: $R"

step "checks before anything is started"
[ -f "$ENV_FILE" ] || refuse "$ENV_NAME is not there (tools/make-dev-env.mjs + tools/set-test-env.mjs)"
# F-1: the settings file cannot reach the live schema, wallet, data directory, partner simulator or chain node …
tool "$HERE/check-test-env.mjs" "$ENV_FILE" | sed 's/^/   /'
[ "${PIPESTATUS[0]}" -eq 0 ] || refuse "$ENV_NAME is not safe for a test server"
# … and it is THIS set's file: its port, schema, partner copy, stand-in node, wallet, a token of its own (F-1, F-2, F-12).
tool "$CHECK" --set "$SET" --constants "core=$CORE_PORT" "chain=$CHAIN_PORT" "partner=$PARTNER_PORT" "bank=$BANK_PORT" "env=$ENV_NAME" > "$LOGS/constants.txt" 2>&1 \
  || { cat "$LOGS/constants.txt"; refuse "this script and check-second-set.mjs do not describe the same set"; }
tool "$CHECK" --set "$SET" --preflight > "$LOGS/preflight.txt" 2>&1 || { cat "$LOGS/preflight.txt"; refuse "$ENV_NAME is not this set's settings file"; }
echo "   $ENV_NAME: $(grep -c '^ok ' "$LOGS/preflight.txt") things checked — this set's own port, schema, data directory, partner copy, stand-in node, wallet, token (preflight.txt)"
for f in deploy/smoke-remit.mjs deploy/smoke-exceptions.mjs; do [ -f "$ATTEST/$f" ] || refuse "$f is missing"; done
for f in demo-partners/server.mjs demo-partners/setup.mjs demo-partners/lib/crypto.mjs demo-partners/chain/client.mjs demo-partners/chain/musdc-artifact.json \
         demo-bank/server.mjs demo-bank/remit.mjs demo-bank/setup.mjs demo-bank/vendor demo-bank/node_modules; do
  [ -e "$REPO/$f" ] || refuse "$f is missing"
done
if [ "$SET" = java ]; then
  [ -x "$JAVA" ] || refuse "no JDK 17 at $JAVA"
  [ -f "$JAR" ] || refuse "no jar at $JAR — it is built by the builder (./mvnw -B -o clean package); this script runs no Maven"
fi
# F-12: the wallet is attest-java, the node has it, and no other service is anchoring from it right now.
tool "$CHECK" --set "$SET" --wallet-free > "$LOGS/wallet-free.txt" 2>&1 || { cat "$LOGS/wallet-free.txt"; refuse "the wallet attest-java is in use"; }
sed -n 's/^ok    /   /p' "$LOGS/wallet-free.txt"
tool "$CHECK" --set "$SET" --wallet > "$LOGS/wallet-before.txt" 2>&1 || { cat "$LOGS/wallet-before.txt"; refuse "the wallet attest-java cannot be used"; }
WALLET_BEFORE="$(grep '^wallet ' "$LOGS/wallet-before.txt")"
echo "   before: $WALLET_BEFORE"

# What the live folders look like now — times and sizes only, never contents — to compare at the end.
live_times() {
  ( cd "$REPO" || exit 1
    for d in demo-partners demo-bank demo-customers demo-bank-java attest/deploy; do
      [ -d "$d" ] && find "$d" \( -name node_modules -o -name vendor \) -prune -o -type f -printf '%p\t%T@\t%s\n'
    done
    find attest/apps/core/.env -printf '%p\t%T@\t%s\n' ) | LC_ALL=C sort
}
live_times > "$LOGS/live-before.tsv"
echo "   the live folders: the times of $(wc -l < "$LOGS/live-before.tsv") files recorded"

# From here on something is started: whatever happens, the end is `finish`.
STARTED=0; SMOKE1_LINE=; SMOKE2_LINE=; T_SMOKE1=; T_SMOKE2=; EXTRA=; WALLET_AFTER=; LIVE=
finish() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if [ "$STARTED" -eq 1 ]; then
    step "stop what was started — by process id, in reverse order"
    stop_all
    local port left=0
    for port in $OWN_PORTS; do taken "$port" && { echo "   port $port is STILL listening"; left=1; }; done
    if [ $left -eq 0 ]; then echo "   ports $OWN_PORTS are free"; elif [ "$code" -eq 0 ]; then code=1; fi
    tool "$CHECK" --set "$SET" --wallet > "$LOGS/wallet-after.txt" 2>&1
    WALLET_AFTER="$(grep '^wallet ' "$LOGS/wallet-after.txt")"
    # F-12, said honestly: this script cannot keep others from starting a service on the wallet while it runs.
    # It looked before it started; it looks again now, and says so if somebody is there.
    tool "$CHECK" --set "$SET" --wallet-free > "$LOGS/wallet-free-after.txt" 2>&1 \
      || { echo "   NOTE: another service is on the wallet attest-java now — if an anchor of this run failed, that is a likely cause:"; sed -n 's/^FAIL  /     /p' "$LOGS/wallet-free-after.txt"; }
    live_times > "$LOGS/live-after.tsv"
    if cmp -s "$LOGS/live-before.tsv" "$LOGS/live-after.tsv"; then
      LIVE="unchanged — the $(wc -l < "$LOGS/live-after.tsv") files of the live folders have the times and sizes they had before"
    else
      LIVE="CHANGED while the set ran — either somebody used the live demos meanwhile, or this run reached them: find out before anything else"
      diff "$LOGS/live-before.tsv" "$LOGS/live-after.tsv" | grep '^[<>]' | cut -f1 | sed 's/^[<>] //' | sort -u | sed 's/^/     changed: /'
      [ "$code" -eq 0 ] && code=4
    fi
    echo
    echo "== summary — set '$SET', $(date -u +%FT%TZ), ${SECONDS} s in all"
    echo "   smoke-remit.mjs      : ${SMOKE1_LINE:-not passed}${T_SMOKE1:+  (${T_SMOKE1} s)}"
    echo "   smoke-exceptions.mjs : ${SMOKE2_LINE:-not passed}${T_SMOKE2:+  (${T_SMOKE2} s)}"
    echo "   extra checks         : ${EXTRA:-not run}"
    echo "   wallet before        : ${WALLET_BEFORE#wallet }"
    echo "   wallet after         : ${WALLET_AFTER#wallet }"
    echo "   live folders         : $LIVE"
    echo "   this run             : $R  ($(find "$W/runs" -mindepth 1 -maxdepth 1 -type d | wc -l) run folders are kept under $W/runs)"
  fi
  if [ "$code" -eq 0 ]; then echo "== PASSED"; else echo "== NOT PASSED (exit $code)"; fi
  exit "$code"
}
trap finish EXIT
trap 'echo; echo "interrupted"; exit 130' INT
trap 'echo; echo "terminated"; exit 143' TERM
STARTED=1

# ── 2. the work folder ───────────────────────────────────────────────────────

step "lay out the work folder"
# A link of this layout: made if absent, kept if it is the one wanted; replaced as a link, never followed.
link() { # link <path> <target>
  if [ -L "$1" ]; then [ "$(readlink "$1")" = "$2" ] && return 0; rm -f -- "$1"
  elif [ -e "$1" ]; then fail "$1 is in the way and is not a link of this layout"; fi
  ln -s -- "$2" "$1" || fail "could not make the link $1"
}
mkdir -p "$W/attest/deploy"
{ [ ! -L "$W/attest" ] && [ ! -L "$W/attest/deploy" ]; } || fail "$W/attest and $W/attest/deploy must be folders of the work folder, not links"
link "$W/attest/apps" "$ATTEST/apps"
link "$W/attest/packages" "$ATTEST/packages"
# The two scripts, byte for byte (F-6, F-7, F-9: the copies are run, never the originals and never the .sh wrappers).
for f in smoke-remit.mjs smoke-exceptions.mjs; do
  [ ! -L "$W/attest/deploy/$f" ] || fail "$W/attest/deploy/$f is a link — the script would run in the repository's folder"
  cp -f -- "$ATTEST/deploy/$f" "$W/attest/deploy/$f"
  a="$(sha256sum < "$ATTEST/deploy/$f" | cut -d' ' -f1)"; b="$(sha256sum < "$W/attest/deploy/$f" | cut -d' ' -f1)"
  { [ "$a" = "$b" ] && [ ${#a} -eq 64 ]; } || fail "the copy of $f is not the original, byte for byte"
  echo "   $f: sha256 $b — the original's"
done
# Program files only. Never state.json, keys/, hsm/*, data/*, work/* (F-3, F-6): each copy makes its own,
# in a folder of this run — a new one every time, as the schema is emptied every time.
P="$R/demo-partners"; B="$R/demo-bank"
mkdir -p "$P/lib" "$P/chain" "$P/data" "$B/hsm" "$B/data" "$B/work"
cp -- "$REPO/demo-partners/server.mjs" "$REPO/demo-partners/setup.mjs" "$P/"
cp -- "$REPO/demo-partners/lib/crypto.mjs" "$P/lib/"
cp -- "$REPO/demo-partners/chain/client.mjs" "$REPO/demo-partners/chain/musdc-artifact.json" "$P/chain/"
[ -d "$REPO/demo-partners/public" ] && cp -a -- "$REPO/demo-partners/public" "$P/public"
cp -- "$REPO/demo-bank/server.mjs" "$REPO/demo-bank/remit.mjs" "$REPO/demo-bank/setup.mjs" "$B/"
cp -a -- "$REPO/demo-bank/vendor" "$B/vendor"
cp -a -- "$REPO/demo-bank/node_modules" "$B/node_modules"
[ -d "$REPO/demo-bank/public" ] && cp -a -- "$REPO/demo-bank/public" "$B/public"
link "$R/attest" "$W/attest"
link "$W/$SET" "$R"
link "$W/demo-bank" "$B"
# The demos listen on every interface as they are written, and the bank demo's /api/config answers with its
# account's password (F-15). The copies are loaded with this in front, which changes nothing but the address
# they listen on — their own files stay byte copies.
cat > "$W/loopback-only.mjs" <<'EOF'
// Written by tools/run-second-set.sh. Loaded in front of the demo copies (node --import): a server that
// would listen on every interface listens on 127.0.0.1 only. Nothing else is changed.
import net from 'node:net';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if ((typeof args[0] === 'number' || typeof args[0] === 'string') && typeof args[1] !== 'string') {
    return listen.call(this, args[0], '127.0.0.1', ...args.slice(1));
  }
  return listen.apply(this, args);
};
EOF
# The copies are the originals, byte for byte …
for f in server.mjs setup.mjs lib/crypto.mjs chain/client.mjs chain/musdc-artifact.json; do cmp -s "$REPO/demo-partners/$f" "$P/$f" || fail "partner copy: $f differs from the original"; done
for f in server.mjs remit.mjs setup.mjs; do cmp -s "$REPO/demo-bank/$f" "$B/$f" || fail "bank copy: $f differs from the original"; done
diff -r -q --no-dereference "$REPO/demo-bank/vendor" "$B/vendor" > /dev/null || fail "bank copy: vendor/ differs from the original"
# … nothing that is a live identity came along …
stray="$(find "$R" \( -name state.json -o -name '*.key' -o -name '*.pem' -o -name '*.key.json' -o -name '.env*' -o -path '*/keys/*' \) -print | head -5)"
[ -z "$stray" ] || fail "a key or state file was copied into the work folder: $stray"
for d in "$P/data" "$B/data" "$B/hsm" "$B/work"; do [ -z "$(ls -A "$d")" ] || fail "$d is not empty"; done
# … nothing stands beside the bank copy for its manifest to read (F-10) …
{ [ ! -e "$R/demo-customers" ] && [ ! -e "$R/demo-bank-java" ]; } || fail "a folder beside the bank copy would be read for its manifest"
# … no link of this run's folder leaves the work folder (the two links into the repository are <W>/attest/apps and packages) …
while IFS= read -r l; do
  case "$(readlink -f "$l")/" in "$W"/*) ;; *) fail "the link $l leaves the work folder" ;; esac
done < <(find "$R" -type l)
# … and the names the processes are started by lead to this run.
{ [ "$(readlink -f "$W/$SET")" = "$R" ] && [ "$(readlink -f "$W/demo-bank")" = "$B" ]; } || fail "$W/$SET or $W/demo-bank does not lead to this run"
echo "   $R: partner copy and bank copy laid out — program files only, identical to the originals; no key, no state"

if [ "$SET" = java ]; then
  # The jar is copied: a build that runs meanwhile (clean) cannot take it away from under the running core.
  { cp -f -- "$JAR" "$W/core-java.jar" && cmp -s "$JAR" "$W/core-java.jar"; } || fail "could not copy the jar"
  echo "   core-java.jar: sha256 $(sha256sum < "$W/core-java.jar" | cut -d' ' -f1), built $(date -u -r "$JAR" +%FT%TZ)"
fi

# ── 3. the set's schema, emptied ─────────────────────────────────────────────

if [ "$SET" = java ]; then
  step "bring the schema of $ENV_NAME to this build's version (migrate)"
  run_gated 180 migrate core-migrate "$MODULE" -- "$JAVA" -jar "$W/core-java.jar" "--env-file=$ENV_FILE" migrate \
    || { tail -5 "$LOGS/migrate.log" | cut -c1-400
         fail "migrate did not succeed. (If a migration of this build was changed after it had been applied to this schema: node apps/core-java/tools/create-schema.mjs apps/core-java/$ENV_NAME --drop, then the same without --drop, and run this again.)"; }
  tail -2 "$LOGS/migrate.log" | cut -c1-300 | sed 's/^/   /'
fi
step "empty the set's schema"
tool "$HERE/clear-test-schema.mjs" "$ENV_FILE" | sed 's/^/   /'
tool "$CHECK" --set "$SET" --schema-empty > "$LOGS/schema-empty.txt" 2>&1 || { cat "$LOGS/schema-empty.txt"; fail "the schema is not empty"; }
sed -n 's/^ok    /   /p' "$LOGS/schema-empty.txt"

if [ "$SET" = java ]; then
  # The first step that needs the settlement rail: every route the two scripts and the two setups call.
  step "does this build of the Java core have the settlement rail?"
  run_gated 180 routes core-routes "$MODULE" -- "$JAVA" -jar "$W/core-java.jar" "--env-file=$ENV_FILE" routes \
    || { tail -5 "$LOGS/routes.log" | cut -c1-400; fail "the route table could not be printed"; }
  missing=()
  while IFS= read -r want; do
    grep -Eqx -- "$want" "$LOGS/routes.log" || missing+=("$(printf '%s' "$want" | sed 's/\[A-Za-z_\]+/id/g')")
  done <<'EOF'
GET /v1/remit/meta
POST /v1/remit/registry/institutions
POST /v1/remit/callbacks
POST /v1/console/signup
POST /v1/console/login
GET /v1/console/issuer-keys
POST /v1/console/issuer-keys
POST /v1/console/products
POST /v1/quotes
POST /v1/settlements
GET /v1/settlements
GET /v1/settlements/:[A-Za-z_]+
GET /v1/settlements/:[A-Za-z_]+/evidence
POST /v1/settlements/:[A-Za-z_]+/cancel
POST /v1/settlements/:[A-Za-z_]+/rfi-response
POST /v1/manifests/daily
EOF
  if [ ${#missing[@]} -gt 0 ]; then
    echo
    echo "THE JAVA CORE OF THIS BUILD DOES NOT HAVE THE SETTLEMENT RAIL YET."
    echo "The two smoke scripts and the demos' setup call these routes, which this build does not serve:"
    printf '   %s\n' "${missing[@]}"
    echo "Nothing was provisioned and no server was started. Run this again when step 5 is built."
    exit 3
  fi
  echo "   every route the scripts call is in this build's route table ($(grep -Ec '^(GET|POST|PUT|DELETE|OPTIONS|PATCH|HEAD) /' "$LOGS/routes.log") routes)"
fi

# ── 4. the stand-in chain node and the core ──────────────────────────────────

step "start the stand-in chain node (:$CHAIN_PORT) and the core (:$CORE_PORT)"
start_gated chain chain "$ATTEST" -- node "$HERE/stand-in-eth-rpc.mjs" --port "$CHAIN_PORT"
CHAIN_PID="$LAST_PID"
if [ "$SET" = java ]; then
  start_gated core core "$MODULE" -- "$JAVA" -jar "$W/core-java.jar" "--env-file=$ENV_FILE" serve
else
  start_gated core core "$ATTEST" -- node "$HERE/run-reference-core.mjs" "$ENV_FILE"
fi
CORE_PID="$LAST_PID"
wait_http "http://127.0.0.1:$CHAIN_PORT/log/summary" 20 || { tail -5 "$LOGS/chain.log" | cut -c1-400; fail "the stand-in chain node did not come up"; }
wait_http "$CORE/healthz" 120 || { tail -8 "$LOGS/core.log" | cut -c1-400; fail "the core did not come up on :$CORE_PORT"; }
echo "   both answer"
# The partner copy reads the platform's key from here, the bank copy the receiving institution's.
code="$(http GET "$CORE/v1/remit/meta")"
if [ "$code" != 200 ] || ! grep -q '"platform_signer"' "$LOGS/last-answer"; then
  echo
  echo "THE CORE ON :$CORE_PORT DOES NOT SERVE THE SETTLEMENT RAIL: GET /v1/remit/meta answered $code."
  echo "Nothing was provisioned. (For the Java core: step 5 is not in this build yet.)"
  [ "$SET" = java ] && exit 3
  exit 1
fi
echo "   GET /v1/remit/meta: 200, the platform's key is published"
# F-2: this core must refuse the sandbox's default admin token (what a setup.mjs run without settings would send).
# An empty body: were the token accepted, the answer would be 400 and still nothing would be registered.
code="$(http POST "$CORE/v1/remit/registry/institutions" -H 'content-type: application/json' -H 'x-admin-token: remit-admin-sandbox' -d '{}')"
[ "$code" = 403 ] || fail "this core answered $code, not 403, to the sandbox's default admin token — its token is not its own"
echo "   the sandbox's default admin token is refused by this core (403)"

# ── 5. provision the two copies — against this core and no other ─────────────

step "provision the partner copy and the bank copy against :$CORE_PORT only"
# The token goes from the settings file into the setup's environment; it is never shown (F-2).
TOKEN="$(tool "$CHECK" --set "$SET" --admin-token-to-pipe)"
[ -n "$TOKEN" ] || fail "the set's admin token could not be read"
run_gated 60 setup-partner partner-setup "$P" "ATTEST_BASE=$CORE" "REMIT_ADMIN_TOKEN=$TOKEN" -- node setup.mjs; rc=$?
unset TOKEN
[ $rc -eq 0 ] || { tail -4 "$LOGS/setup-partner.log" | cut -c1-300; fail "the partner copy's setup.mjs did not succeed (exit $rc) — it registers three institutions with POST /v1/remit/registry/institutions"; }
echo "   $(grep -c '^registered ' "$LOGS/setup-partner.log") institutions registered by the partner copy (SG-BFI-001, SG-PAYBANK-001, SETTLE-ENTITY-001)"
run_gated 60 setup-bank bank-setup "$B" "ATTEST_BASE=$CORE" -- node setup.mjs; rc=$?
[ $rc -eq 0 ] || { grep -v 'api key' "$LOGS/setup-bank.log" | tail -4 | cut -c1-300; fail "the bank copy's setup.mjs did not succeed (exit $rc)"; }
echo "   the bank copy signed up on this core and registered its key"
tool "$CHECK" --set "$SET" --work "$W" --provisioned > "$LOGS/provisioned.txt" 2>&1 || { cat "$LOGS/provisioned.txt"; fail "the copies are not provisioned against this core"; }
sed -n 's/^ok    /   /p' "$LOGS/provisioned.txt"

# ── 6. start the two copies ──────────────────────────────────────────────────

step "start the partner copy (:$PARTNER_PORT, mock chain) and the bank copy (:$BANK_PORT)"
# F-3: CHAIN_BACKEND=mock and a closed port for ANVIL_URL — the copy must never reach the shared chain node.
# F-4, F-5: ATTEST_BASE and BANK_PUBLIC_BASE are the set's; the gate lets neither copy run without them.
DEMO_ENV=("ATTEST_BASE=$CORE" "CHAIN_BACKEND=mock" "ANVIL_URL=http://127.0.0.1:1" "BANK_PUBLIC_BASE=$BANK" "ATTEST_PUBLIC_BASE=$CORE" "PARTNERS_PUBLIC_BASE=$PARTNER")
start_gated partner partner "$W/$SET/demo-partners" "${DEMO_ENV[@]}" "PORT=$PARTNER_PORT" -- node --import "file://$W/loopback-only.mjs" server.mjs
PARTNER_PID="$LAST_PID"
wait_http "$PARTNER/healthz" 30 || { tail -5 "$LOGS/partner.log" | cut -c1-300; fail "the partner copy did not come up — do its linked imports resolve?"; }
tool "$CHECK" --set "$SET" --partner > "$LOGS/partner-mock.txt" 2>&1 || { cat "$LOGS/partner-mock.txt"; fail "the partner copy is not on the mock chain — everything is stopped"; }
sed -n 's/^ok    /   /p' "$LOGS/partner-mock.txt"
start_gated bank bank "$W/$SET/demo-bank" "${DEMO_ENV[@]}" "PORT=$BANK_PORT" -- node --import "file://$W/loopback-only.mjs" server.mjs
BANK_PID="$LAST_PID"
wait_http "$BANK/api/remit/config" 30 || { tail -5 "$LOGS/bank.log" | cut -c1-300; fail "the bank copy did not come up"; }
# F-15: none of the four listens on anything but 127.0.0.1.
for port in $OWN_PORTS; do
  where="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E "[:.]$port\$" | sed 's/^\[::ffff:127\.0\.0\.1\]/127.0.0.1/' | sort -u | tr '\n' ' ')"
  [ "$where" = "127.0.0.1:$port " ] || fail "port $port listens on '$where', not on 127.0.0.1 alone"
done
echo "   ports $OWN_PORTS listen on 127.0.0.1 only"
code="$(http POST "$BANK/api/remit/subscribe")"
[ "$code" = 200 ] || { head -c 300 "$LOGS/last-answer"; echo; fail "the bank copy could not subscribe to the rail ($code)"; }
tool "$CHECK" --set "$SET" --bank-webhook > "$LOGS/bank-webhook.txt" 2>&1 || { cat "$LOGS/bank-webhook.txt"; fail "the bank copy's webhook address is not its own"; }
sed -n 's/^ok    /   /p' "$LOGS/bank-webhook.txt"

# ── 7. the two scripts ───────────────────────────────────────────────────────

# F-6: smoke-remit.mjs takes the bank's identity from ../../demo-bank beside the folder it runs in. That must be
# this run's copy — looked at once more, now, with the copy's own state in place.
{ [ "$(readlink -f "$W/demo-bank")" = "$B" ] && [ "$(readlink -f "$W/attest/deploy/../../demo-bank/state.json")" = "$B/state.json" ]; } \
  || fail "../../demo-bank beside $W/attest/deploy is not this run's bank copy"

step "smoke-remit.mjs (the copy, run in $W/attest/deploy)"
t0=$SECONDS
run_gated 420 smoke-remit smoke-remit "$W/attest/deploy" "ATTEST_BASE=$CORE" "REMIT_WEBHOOK_URL=$WEBHOOK" -- node smoke-remit.mjs; rc=$?
T_SMOKE1=$((SECONDS - t0))
sed 's/^/   | /' "$LOGS/smoke-remit.log"
SMOKE1_LINE="$(grep -m1 '^✓ smoke passed' "$LOGS/smoke-remit.log" || true)"
{ [ $rc -eq 0 ] && [ -n "$SMOKE1_LINE" ]; } || { SMOKE1_LINE=; fail "smoke-remit.mjs did not pass (exit $rc)"; }

step "smoke-exceptions.mjs (the copy, run in $W/attest/deploy)"
t0=$SECONDS
run_gated 900 smoke-exceptions smoke-exceptions "$W/attest/deploy" "BANK_BASE=$BANK" -- node smoke-exceptions.mjs; rc=$?
T_SMOKE2=$((SECONDS - t0))
sed 's/^/   | /' "$LOGS/smoke-exceptions.log"
SMOKE2_LINE="$(grep -m1 '^✓ exception matrix passed' "$LOGS/smoke-exceptions.log" || true)"
{ [ $rc -eq 0 ] && [ -n "$SMOKE2_LINE" ]; } || { SMOKE2_LINE=; fail "smoke-exceptions.mjs did not pass (exit $rc)"; }

# ── 8. the extra checks ──────────────────────────────────────────────────────

step "extra checks (check-second-set.mjs --after)"
tool "$CHECK" --set "$SET" --work "$W" --after > "$LOGS/after.txt" 2>&1; rc=$?
sed 's/^/   /' "$LOGS/after.txt"
[ $rc -eq 0 ] || { EXTRA="FAILED"; fail "the extra checks did not pass"; }
# What the core asked the chain's stand-in (the console's "what does the chain say" lookup; no step of the scripts needs it).
code="$(http GET "http://127.0.0.1:$CHAIN_PORT/log/summary")"
[ "$code" = 200 ] && { cp -- "$LOGS/last-answer" "$LOGS/stand-in-summary.json"; echo "   the stand-in chain node was asked: $(head -c 300 "$LOGS/stand-in-summary.json")"; }

step "the environment of the processes that ran the set, once more"
tool "$CHECK" --set "$SET" --work "$W" --env "chain=$CHAIN_PID" "core=$CORE_PID" "partner=$PARTNER_PID" "bank=$BANK_PID" > "$LOGS/env.running.txt" 2>&1; rc=$?
sed 's/^/   /' "$LOGS/env.running.txt"
[ $rc -eq 0 ] || { EXTRA="FAILED (environment)"; fail "a process of the set did not have the set's own environment"; }
EXTRA="passed ($(grep -c '^ok ' "$LOGS/after.txt") checks after the scripts; the environment of each of the $(ls "$LOGS"/env.*.txt | grep -vc 'env\.running\.txt$') processes started was the set's own)"
exit 0
