#!/usr/bin/env bash
#
# Pull the latest main onto the NAS and rebuild the container.
#
# Two things this has to get right, both learned the hard way:
#   - `ssh -t`, because docker on DSM needs sudo and sudo needs a terminal to
#     prompt on. Without it you get "sudo: a terminal is required".
#   - `ssh -A`, because the repo is private and the NAS has no deploy key; it
#     authenticates to GitHub with your forwarded agent.
#
# Usage: ./redeploy.sh [ssh-host] [--force]
#   ssh-host   defaults to $BACKUPBOT_SSH_HOST
#   --force    rebuild even when there is nothing new to pull
set -euo pipefail

HOST=""
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,${/^#/!q;s/^# \{0,1\}//;p;}' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) HOST="$arg" ;;
  esac
done
HOST="${HOST:-${BACKUPBOT_SSH_HOST:-}}"

if [ -z "$HOST" ]; then
  echo "No SSH host. Usage: ./redeploy.sh <ssh-host> [--force]" >&2
  echo "Or set BACKUPBOT_SSH_HOST. The host is whatever you type after \`ssh\`." >&2
  exit 2
fi

REMOTE_SRC="${BACKUPBOT_REMOTE_SRC:-/volume1/docker/backupbot/src}"
REMOTE_PORT="${BACKUPBOT_REMOTE_PORT:-7817}"
BRANCH="${BACKUPBOT_BRANCH:-main}"

echo "==> redeploying backupbot on ${HOST}:${REMOTE_SRC}"

# Passed as an argument rather than on stdin, because -t hands stdin to the TTY.
HOST_LABEL="$HOST"
read -r -d '' REMOTE_SCRIPT <<REMOTE || true
set -eu
cd '${REMOTE_SRC}'

if [ -n "\$(git status --porcelain)" ]; then
  echo "refusing to pull: the checkout has local changes" >&2
  git status --short >&2
  exit 1
fi

BEFORE=\$(git rev-parse HEAD)
git fetch --quiet origin '${BRANCH}'
AFTER=\$(git rev-parse 'origin/${BRANCH}')

if [ "\$BEFORE" = "\$AFTER" ]; then
  echo "already at \$(git rev-parse --short HEAD) — nothing to pull"
  if [ '${FORCE}' != '1' ]; then
    echo "(pass --force to rebuild anyway)"
    exit 0
  fi
else
  echo "--- incoming ---"
  git --no-pager log --oneline "\$BEFORE..\$AFTER"
  git merge --ff-only --quiet 'origin/${BRANCH}'
  echo "--- now at \$(git rev-parse --short HEAD) ---"
fi

# docker is not on DSM's non-interactive PATH — it lives under the
# ContainerManager package — and sudo's secure_path may not cover it either, so
# resolve it here rather than relying on either.
DOCKER=\$(command -v docker 2>/dev/null || true)
if [ -z "\$DOCKER" ] && [ -x /usr/local/bin/docker ]; then DOCKER=/usr/local/bin/docker; fi
if [ -z "\$DOCKER" ]; then
  echo "docker not found on ${HOST_LABEL}. Is Container Manager installed?" >&2
  exit 1
fi
COMPOSE="sudo \$DOCKER compose -f docker/docker-compose.yml"

echo "==> building (sudo: the docker socket on DSM is root-only)"
\$COMPOSE up -d --build

echo "==> waiting for the engine"
for i in \$(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:${REMOTE_PORT}/health" >/dev/null 2>&1; then
    echo "healthy: \$(curl -fsS -m 2 http://127.0.0.1:${REMOTE_PORT}/health)"
    \$COMPOSE logs --tail 15
    exit 0
  fi
  sleep 1
done

echo "engine did not answer on 127.0.0.1:${REMOTE_PORT} within 60s" >&2
\$COMPOSE logs --tail 40 >&2
exit 1
REMOTE

ssh -A -t "$HOST" "$REMOTE_SCRIPT"
