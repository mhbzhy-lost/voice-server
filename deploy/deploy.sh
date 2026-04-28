#!/usr/bin/env bash
# voice-server SSH deploy automation
# Subcommands: bootstrap | sync | restart | status | logs | full
set -euo pipefail

# ===== Load .env =====
SCRIPT_DIR_EARLY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT_EARLY="$(cd "$SCRIPT_DIR_EARLY/.." && pwd)"
if [ -f "$PROJECT_ROOT_EARLY/.env" ]; then
  set -a; . "$PROJECT_ROOT_EARLY/.env"; set +a
fi

# ===== Configuration =====
HOST="${VOICE_HOST:-}"
USER="${VOICE_SSH_USER:-}"
KEY="${VOICE_SSH_KEY:-}"
if [ -z "$HOST" ]; then echo "missing VOICE_HOST in .env" >&2; exit 1; fi
if [ -z "$USER" ]; then echo "missing VOICE_SSH_USER in .env" >&2; exit 1; fi
if [ -z "$KEY" ];  then echo "missing VOICE_SSH_KEY in .env" >&2; exit 1; fi
REMOTE_DIR="${REMOTE_DIR:-/opt/voice-server}"
PORT="${PORT:-3000}"
NODE_MAJOR="${NODE_MAJOR:-20}"
ENV_FILE_REMOTE="/etc/voice-server.env"
SERVICE_NAME="voice-server"

SCRIPT_DIR="$SCRIPT_DIR_EARLY"
PROJECT_DIR="$PROJECT_ROOT_EARLY"

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
SSH="ssh ${SSH_OPTS[*]} ${USER}@${HOST}"

c_blue() { printf '\033[1;34m[%s]\033[0m %s\n' "deploy" "$*"; }
c_red()  { printf '\033[1;31m[%s]\033[0m %s\n' "deploy" "$*" >&2; }
c_grn()  { printf '\033[1;32m[%s]\033[0m %s\n' "deploy" "$*"; }

remote() {
  ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "$@"
}

remote_sudo() {
  ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo bash -c \"$*\""
}

cmd_bootstrap() {
  c_blue "Bootstrapping remote $HOST ..."

  # Step 1: build toolchain + utilities
  remote 'sudo dnf install -y gcc-c++ make python3 tar xz rsync curl >/dev/null'
  c_grn "Build toolchain present."

  # Step 2: Node.js install (idempotent)
  # NOTE: NodeSource (rpm.nodesource.com) and raw.githubusercontent.com (NVM)
  # are blocked / very slow from many CN regions. We default to the npmmirror
  # (Alibaba) binary tarball which is fast & reliable from CN ECS.
  local NODE_FULL="v20.18.0"
  if remote "command -v node >/dev/null 2>&1 && node -v | grep -q '^v${NODE_MAJOR}\\.'"; then
    c_grn "Node.js v${NODE_MAJOR}.x already installed: $(remote 'node -v')"
  else
    c_blue "Installing Node.js ${NODE_FULL} via npmmirror tarball ..."
    if remote "set -e; cd /tmp; A=node-${NODE_FULL}-linux-x64.tar.xz; \
      curl -fsSL --max-time 120 -o \$A https://registry.npmmirror.com/-/binary/node/${NODE_FULL}/\$A && \
      sudo rm -rf /usr/local/lib/nodejs && sudo mkdir -p /usr/local/lib/nodejs && \
      sudo tar -xJf \$A -C /usr/local/lib/nodejs && \
      sudo ln -sf /usr/local/lib/nodejs/node-${NODE_FULL}-linux-x64/bin/node /usr/bin/node && \
      sudo ln -sf /usr/local/lib/nodejs/node-${NODE_FULL}-linux-x64/bin/npm /usr/bin/npm && \
      sudo ln -sf /usr/local/lib/nodejs/node-${NODE_FULL}-linux-x64/bin/npx /usr/bin/npx && \
      rm -f \$A"; then
      c_grn "Node tarball install OK: $(remote 'node -v')"
    else
      c_red "npmmirror install failed; trying NodeSource ..."
      if remote "curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | sudo bash - >/dev/null 2>&1 && sudo dnf install -y nodejs >/dev/null 2>&1"; then
        c_grn "NodeSource install OK: $(remote 'node -v')"
      else
        c_red "All Node install routes failed."
        return 1
      fi
    fi
  fi
  # Configure npm to use CN mirror for faster + reliable installs
  remote "npm config set registry https://registry.npmmirror.com >/dev/null 2>&1 || true"

  # Step 3: remote dir
  remote "sudo mkdir -p ${REMOTE_DIR} && sudo chown ${USER}:${USER} ${REMOTE_DIR}"
  c_grn "Remote dir ready: ${REMOTE_DIR}"

  # Step 4: env file (only generate if missing — keep password stable across re-bootstraps)
  if remote "sudo test -f ${ENV_FILE_REMOTE}"; then
    c_grn "Env file already exists at ${ENV_FILE_REMOTE} (preserving)"
  else
    local pw
    pw="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)"
    remote "sudo tee ${ENV_FILE_REMOTE} >/dev/null <<EOF
PORT=${PORT}
STUN_PORT=3478
SUPERADMIN_PASSWORD=${pw}
NODE_ENV=production
EOF
sudo chown root:${USER} ${ENV_FILE_REMOTE}
sudo chmod 640 ${ENV_FILE_REMOTE}"
    c_grn "Env file created at ${ENV_FILE_REMOTE}"
    echo
    echo "============================================================"
    echo "GENERATED SUPERADMIN_PASSWORD: ${pw}"
    echo "(Save this — it will not be displayed again)"
    echo "============================================================"
    echo
  fi

  # Step 5: systemd unit (replace __VOICE_SSH_USER__ placeholder before installing)
  sed "s/__VOICE_SSH_USER__/${USER}/g" "${SCRIPT_DIR}/voice-server.service" \
    | ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee /etc/systemd/system/voice-server.service >/dev/null"
  remote "sudo chown root:root /etc/systemd/system/voice-server.service && sudo chmod 644 /etc/systemd/system/voice-server.service && sudo systemctl daemon-reload && sudo systemctl enable voice-server.service >/dev/null"
  c_grn "systemd unit installed and enabled."
}

cmd_sync() {
  c_blue "Rsyncing project to ${USER}@${HOST}:${REMOTE_DIR} ..."
  rsync -az --delete \
    -e "ssh ${SSH_OPTS[*]}" \
    --exclude-from="${SCRIPT_DIR}/.rsync-exclude" \
    "${PROJECT_DIR}/" "${USER}@${HOST}:${REMOTE_DIR}/"
  c_grn "Rsync done."

  c_blue "Installing production dependencies (npm ci --omit=dev) ..."
  remote "cd ${REMOTE_DIR} && npm ci --omit=dev"
  c_grn "npm ci done."
}

cmd_restart() {
  c_blue "Restarting ${SERVICE_NAME} ..."
  remote "sudo systemctl restart ${SERVICE_NAME}"
  sleep 2
  cmd_status
}

cmd_status() {
  remote "sudo systemctl status ${SERVICE_NAME} --no-pager -l || true"
}

cmd_logs() {
  remote "sudo journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
}

verify_listen() {
  c_blue "Verifying remote listen on :${PORT} ..."
  if remote "ss -tlnp 2>/dev/null | grep -q ':${PORT}\\b'"; then
    c_grn "Remote IS listening on :${PORT}"
    remote "ss -tlnp | grep ':${PORT}\\b' || true"
    return 0
  else
    c_red "Remote NOT listening on :${PORT}"
    return 1
  fi
}

verify_http_local_remote() {
  c_blue "Curling http://127.0.0.1:${PORT}/ on remote ..."
  remote "curl -sS -o /dev/null -w 'HTTP %{http_code} (size=%{size_download})\n' http://127.0.0.1:${PORT}/" || return 1
}

verify_http_public() {
  c_blue "Curling http://${HOST}:${PORT}/ from local ..."
  local out
  if out="$(curl --noproxy '*' -sS --max-time 8 -o /dev/null -w 'HTTP %{http_code}' "http://${HOST}:${PORT}/" 2>&1)" && [[ "$out" == *"200"* ]]; then
    c_grn "Public reachable: ${out}"
    return 0
  else
    c_red "Public NOT reachable: ${out}"
    c_red "Likely cause: Aliyun ECS Security Group does not allow inbound TCP/${PORT}."
    c_red "Action: Open Aliyun Console → ECS → Security Groups → add inbound rule for TCP/${PORT} (0.0.0.0/0 or your IP)."
    return 1
  fi
}

cmd_full() {
  cmd_bootstrap
  cmd_sync
  c_blue "Starting service ..."
  remote "sudo systemctl restart ${SERVICE_NAME}"
  sleep 4
  cmd_status || true
  verify_listen || true
  verify_http_local_remote || true
  verify_http_public || true
}

main() {
  local sub="${1:-}"
  case "$sub" in
    bootstrap) cmd_bootstrap ;;
    sync)      cmd_sync ;;
    restart)   cmd_restart ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    full)      cmd_full ;;
    verify)    verify_listen; verify_http_local_remote; verify_http_public ;;
    *) echo "Usage: $0 {bootstrap|sync|restart|status|logs|verify|full}" >&2; exit 1 ;;
  esac
}

main "$@"
