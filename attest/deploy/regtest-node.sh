#!/usr/bin/env bash
# Bring up a local regtest bitcoind for the sandbox, in its own data directory.
#
#   ./deploy/regtest-node.sh start   # start, create wallet, fund it
#   ./deploy/regtest-node.sh mine 1  # confirm pending anchors
#   ./deploy/regtest-node.sh cli ... # anything else
#   ./deploy/regtest-node.sh stop
#
# regtest needs no initial block download and no faucet: blocks are mined on
# demand, so an anchor confirms in about a second instead of ten minutes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATADIR="${REGTEST_DATADIR:-$ROOT/.regtest}"
RPCPORT="${REGTEST_RPCPORT:-18443}"
RPCUSER="${REGTEST_RPCUSER:-attest}"
RPCPASS="${REGTEST_RPCPASSWORD:-attestlocal}"
WALLET="${REGTEST_WALLET:-attest}"
CLI=(bitcoin-cli -datadir="$DATADIR" -rpcport="$RPCPORT" -rpcuser="$RPCUSER" -rpcpassword="$RPCPASS")

write_conf() {
  mkdir -p "$DATADIR"
  cat > "$DATADIR/bitcoin.conf" <<CONF
regtest=1
server=1
listen=0
printtoconsole=0
fallbackfee=0.0002
# A BC01 anchor payload is 53 bytes. Set explicitly so the anchor path does not
# depend on a node's default datacarrier limit.
datacarriersize=100
[regtest]
rpcport=$RPCPORT
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcuser=$RPCUSER
rpcpassword=$RPCPASS
CONF
}

case "${1:-}" in
  start)
    command -v bitcoind >/dev/null || { echo "bitcoind not found on PATH" >&2; exit 1; }
    write_conf
    bitcoind -datadir="$DATADIR" -daemon
    "${CLI[@]}" -rpcwait getblockchaininfo >/dev/null
    "${CLI[@]}" -named createwallet wallet_name="$WALLET" >/dev/null 2>&1 \
      || "${CLI[@]}" loadwallet "$WALLET" >/dev/null 2>&1 || true
    # 101 blocks: coinbase outputs mature after 100, so this is the smallest
    # number that leaves a spendable balance for anchor fees.
    if [[ "$("${CLI[@]}" getblockcount)" -lt 101 ]]; then
      addr="$("${CLI[@]}" -rpcwallet="$WALLET" getnewaddress)"
      "${CLI[@]}" generatetoaddress 101 "$addr" >/dev/null
    fi
    echo "regtest up: height=$("${CLI[@]}" getblockcount) balance=$("${CLI[@]}" -rpcwallet="$WALLET" getbalance)"
    echo "set BITCOIND_URL=http://127.0.0.1:$RPCPORT BITCOIND_USER=$RPCUSER BITCOIND_PASSWORD=$RPCPASS BITCOIND_WALLET=$WALLET"
    ;;
  mine)
    addr="$("${CLI[@]}" -rpcwallet="$WALLET" getnewaddress)"
    "${CLI[@]}" generatetoaddress "${2:-1}" "$addr" >/dev/null
    echo "height=$("${CLI[@]}" getblockcount)"
    ;;
  stop) "${CLI[@]}" stop ;;
  cli)  shift; "${CLI[@]}" -rpcwallet="$WALLET" "$@" ;;
  *) echo "usage: $0 {start|mine [n]|stop|cli ...}" >&2; exit 2 ;;
esac
