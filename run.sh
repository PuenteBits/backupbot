#!/usr/bin/env bash
#
# Start the backupbot TUI.
#
# By default it connects to a NAS: the launcher opens an SSH tunnel, reads the
# API token off the engine, and closes the tunnel again when you quit. Nothing
# is left listening and no token is written to this machine.
#
# Usage: ./run.sh [ssh-host]
#        ./run.sh --local        against an engine on this machine
#   ssh-host   defaults to $BACKUPBOT_SSH_HOST
set -euo pipefail

cd "$(dirname "$0")"

HOST=""
LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL=1 ;;
    -h|--help) sed -n '2,${/^#/!q;s/^# \{0,1\}//;p;}' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) HOST="$arg" ;;
  esac
done

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed. See https://bun.sh" >&2
  exit 1
fi

# A fresh clone has no node_modules, and the TUI's failure without them is a
# stack trace rather than an explanation.
if [ ! -d node_modules ]; then
  echo "==> installing dependencies"
  bun install
fi

if [ "$LOCAL" = "1" ]; then
  # exec: the TUI owns the terminal and should receive ctrl-c directly.
  exec bun run packages/tui/src/index.tsx
fi

HOST="${HOST:-${BACKUPBOT_SSH_HOST:-}}"
if [ -z "$HOST" ]; then
  echo "No SSH host. Usage: ./run.sh <ssh-host>   (or ./run.sh --local)" >&2
  echo "Or set BACKUPBOT_SSH_HOST. The host is whatever you type after \`ssh\`." >&2
  exit 2
fi

# The file, not the `tui:remote` package script: `bun run <script-name>` spawns
# a child, and a kill -9 on that wrapper would strand the tunnel the child
# holds. exec + direct path keeps this one process from shell to launcher.
exec bun run packages/tui/src/remote.ts "$HOST"
