#!/usr/bin/env bash
# Shared environment loading. Sourced by run-core.sh and smoke.sh so the service
# and anything that pokes at its database always read the same configuration —
# the first version of smoke.sh loaded nothing and silently talked to whatever
# node happened to be on the default port.
# shellcheck shell=bash

_load_env() {
  local app="$1"
  if [[ -f "$app/.env" ]]; then
    set -a
    # shellcheck disable=SC1090,SC1091
    source "$app/.env"
    set +a
  fi
}

_require_node() {
  command -v node >/dev/null || { echo "node not found on PATH" >&2; return 1; }
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major < 22 )); then
    echo "node >= 22 required (found $(node -v)): built-in TypeScript and SQLite are used" >&2
    return 1
  fi
}
