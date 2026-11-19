#!/usr/bin/env bash
# Start Attest Core in the foreground. Reads apps/core/.env if present.
#
# Deliberately not a service manager: this is `node src/main.ts` with the
# environment loaded. Wrap it in whatever the host already uses — pm2, systemd,
# a container — rather than adopting a supervisor just for this.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=_env.sh
source "$ROOT/deploy/_env.sh"

_load_env "$ROOT/apps/core"
_require_node

cd "$ROOT/apps/core"
exec node src/main.ts
