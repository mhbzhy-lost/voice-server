#!/usr/bin/env bash
# voice-server EDGE incremental sync (US ECS).
#
# Pushes ONLY public/ + stun/ to /opt/voice-edge and restarts the STUN
# service. Does NOT touch nginx config or TLS — those are bootstrap-only.
#
# Required .env vars: VOICE_EDGE_HOST, VOICE_EDGE_SSH_USER, VOICE_EDGE_SSH_KEY
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a; . "$PROJECT_DIR/.env"; set +a
fi

HOST="${VOICE_EDGE_HOST:-}"
USER="${VOICE_EDGE_SSH_USER:-}"
KEY="${VOICE_EDGE_SSH_KEY:-}"

[ -n "$HOST" ] || { echo "missing VOICE_EDGE_HOST in .env" >&2; exit 1; }
[ -n "$USER" ] || { echo "missing VOICE_EDGE_SSH_USER in .env" >&2; exit 1; }
[ -n "$KEY" ]  || { echo "missing VOICE_EDGE_SSH_KEY in .env" >&2; exit 1; }

REMOTE_DIR="/opt/voice-edge"
STUN_UNIT="voice-edge-stun.service"

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

c_blue() { printf '\033[1;34m[%s]\033[0m %s\n' "edge-sync" "$*"; }
c_grn()  { printf '\033[1;32m[%s]\033[0m %s\n' "edge-sync" "$*"; }

remote() { ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "$@"; }

c_blue "Rsyncing public/ -> ${HOST}:${REMOTE_DIR}/public/ ..."
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude='.DS_Store' \
  "${PROJECT_DIR}/public/" "${USER}@${HOST}:${REMOTE_DIR}/public/"

c_blue "Rsyncing stun/ -> ${HOST}:${REMOTE_DIR}/stun/ ..."
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude='.DS_Store' \
  "${PROJECT_DIR}/stun/" "${USER}@${HOST}:${REMOTE_DIR}/stun/"

c_blue "Restarting ${STUN_UNIT} ..."
remote "sudo systemctl restart ${STUN_UNIT}"
sleep 1
remote "systemctl is-active ${STUN_UNIT}" || true

c_grn "Edge sync complete."
