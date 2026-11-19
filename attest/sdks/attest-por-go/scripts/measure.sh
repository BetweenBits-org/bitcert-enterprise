#!/usr/bin/env bash
#
# Measures how long the SDK takes, and how much memory, at a given number of
# accounts with three assets. This is how the figures in the README were
# taken.
#
#   scripts/measure.sh              100,000 and 300,000 accounts
#   scripts/measure.sh 50000        one size of your choosing
#
# Three measurements a size, one after the other and never two at once:
#
#   rows to root    ledger rows already in memory, through the ledger builder,
#                   to a built tree — the road a database integration takes
#   file to files   the same ledger as a CSV export, through the example's
#                   "build": read, tree, statement, private files written
#   one proof       the example's "prove": the directory read back, checked,
#                   the tree rebuilt, one customer's proof issued
#
# Each run is given the machine's memory to itself. The Go runtime is told to
# keep its heap under 2 GiB (it collects harder as it nears that, rather than
# growing), and the shell refuses the process more than 4 GiB of address
# space outright.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="$root/.build"
work="$build/measure-work"
sizes=("$@")
[ ${#sizes[@]} -gt 0 ] || sizes=(100000 300000)

mkdir -p "$build"
(
  cd "$root"
  export GOCACHE="${GOCACHE:-$build/gocache}" GOPROXY=off GOTOOLCHAIN=local CGO_ENABLED=0
  go build -o "$build/measure" ./internal/measure
  go build -o "$build/por-example" ./examples/por-example
)

# timed LABEL COMMAND...: runs one command under the limits and prints what
# it cost. The command's own output is kept in .build/measure.out.
timed() {
  local label="$1"; shift
  (
    ulimit -v 4194304
    GOMEMLIMIT=2GiB /usr/bin/time -v -o "$build/measure.time" "$@" > "$build/measure.out"
  )
  awk -v label="$label" '
    /Elapsed \(wall clock\)/ { wall = $NF }
    /Maximum resident set size/ { rss = $NF }
    END { printf "  %-14s wall %s   peak resident set %d MB\n", label, wall, (rss + 512) / 1024 }
  ' "$build/measure.time"
}

for accounts in "${sizes[@]}"; do
  echo "== $accounts accounts, 3 assets"
  rm -rf "$work"; mkdir -p "$work"

  timed "rows to root" "$build/measure" -accounts "$accounts"
  sed 's/^/    /' "$build/measure.out"

  "$build/measure" -accounts "$accounts" -export "$work/balances.csv"
  timed "file to files" "$build/por-example" build --csv "$work/balances.csv" --amounts decimal \
    --assets BTC:8,ETH:18,USDT:6 --exchange KR-EX-measure --name Measure --asof 2026-11-16T00:00:00Z \
    --out "$work/snapshot"
  echo "  (export $(du -h "$work/balances.csv" | cut -f1), leaves file $(du -h "$work/snapshot/leaves.jsonl" | cut -f1))"

  timed "one proof" "$build/por-example" prove --dir "$work/snapshot" --user-ref "user-$(printf '%07d' $((accounts / 2)))" --out "$work/proof.json"
  rm -rf "$work"
done
rm -f "$build/measure.time" "$build/measure.out"
