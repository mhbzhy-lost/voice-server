#!/usr/bin/env bash
# voice-server SSH deploy automation
# Subcommands: bootstrap | sync | restart | status | logs | verify | gen-cert | full
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
TLS_DIR_REMOTE="${REMOTE_DIR}/tls"
TLS_CERT_REMOTE="${TLS_DIR_REMOTE}/cert.pem"
TLS_KEY_REMOTE="${TLS_DIR_REMOTE}/key.pem"
TLS_CERT_DAYS="${TLS_CERT_DAYS:-397}"
TLS_RENEW_BEFORE_DAYS="${TLS_RENEW_BEFORE_DAYS:-30}"
REMOTE_SCRIPTS_DIR="${REMOTE_DIR}/scripts"
REMOTE_RENEW_SCRIPT="${REMOTE_SCRIPTS_DIR}/cert-renew.sh"
RENEW_UNIT_NAME="voice-server-cert-renew"

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

  # Step 4b: TLS cert + env wiring (idempotent)
  cmd_apply_tls_env
  remote_env_upsert "VOICE_SAN_HOST" "${HOST}"
  remote_env_upsert "VOICE_OWNER"    "${USER}"
  remote_env_upsert "VOICE_GROUP"    "${USER}"
  remote "sudo mkdir -p ${TLS_DIR_REMOTE} && sudo chown ${USER}:${USER} ${TLS_DIR_REMOTE} && sudo chmod 755 ${TLS_DIR_REMOTE}"
  cmd_install_cert_renew_unit
  # Trigger one renewal pass (no-op if cert is valid).
  remote "sudo ${REMOTE_RENEW_SCRIPT}"

  # Step 5: systemd unit (replace __VOICE_SSH_USER__ placeholder before installing)
  sed "s/__VOICE_SSH_USER__/${USER}/g" "${SCRIPT_DIR}/voice-server.service" \
    | ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee /etc/systemd/system/voice-server.service >/dev/null"
  remote "sudo chown root:root /etc/systemd/system/voice-server.service && sudo chmod 644 /etc/systemd/system/voice-server.service && sudo systemctl daemon-reload && sudo systemctl enable voice-server.service >/dev/null"
  c_grn "systemd unit installed and enabled."
}

# ---------------------------------------------------------------------------
# TLS: self-signed cert with IP-SAN so browsers treat the origin as Secure
# Context. The actual openssl logic lives in deploy/cert-renew.sh which is
# pushed to the remote host; that single script is shared by this command
# and by the systemd timer. Cert/key are generated locally on the remote so
# the private key never leaves it.
# ---------------------------------------------------------------------------
cmd_gen_cert() {
  c_blue "Forcing TLS cert renewal via remote script ..."
  cmd_install_cert_renew_script
  cmd_apply_tls_env
  remote "sudo ${REMOTE_RENEW_SCRIPT} --force"
  c_grn "Cert renewal complete."
}

# Push deploy/cert-renew.sh -> /opt/voice-server/scripts/cert-renew.sh and set
# permissions. Idempotent.
cmd_install_cert_renew_script() {
  remote "sudo mkdir -p ${REMOTE_SCRIPTS_DIR} && sudo chown root:root ${REMOTE_SCRIPTS_DIR} && sudo chmod 755 ${REMOTE_SCRIPTS_DIR}"
  ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee ${REMOTE_RENEW_SCRIPT} >/dev/null" < "${SCRIPT_DIR}/cert-renew.sh"
  remote "sudo chown root:root ${REMOTE_RENEW_SCRIPT} && sudo chmod 755 ${REMOTE_RENEW_SCRIPT}"
  c_grn "cert-renew.sh installed at ${REMOTE_RENEW_SCRIPT}"
}

# Install/update the systemd service+timer units, enable the timer.
cmd_install_cert_renew_unit() {
  cmd_install_cert_renew_script
  # Make sure VOICE_SAN_HOST is in the env file so the script can read it.
  remote_env_upsert "VOICE_SAN_HOST" "${HOST}"
  remote_env_upsert "VOICE_OWNER"    "${USER}"
  remote_env_upsert "VOICE_GROUP"    "${USER}"

  ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee /etc/systemd/system/${RENEW_UNIT_NAME}.service >/dev/null" < "${SCRIPT_DIR}/${RENEW_UNIT_NAME}.service"
  ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee /etc/systemd/system/${RENEW_UNIT_NAME}.timer >/dev/null" < "${SCRIPT_DIR}/${RENEW_UNIT_NAME}.timer"
  remote "sudo chown root:root /etc/systemd/system/${RENEW_UNIT_NAME}.service /etc/systemd/system/${RENEW_UNIT_NAME}.timer && sudo chmod 644 /etc/systemd/system/${RENEW_UNIT_NAME}.service /etc/systemd/system/${RENEW_UNIT_NAME}.timer"
  remote "sudo systemctl daemon-reload && sudo systemctl enable --now ${RENEW_UNIT_NAME}.timer"
  c_grn "${RENEW_UNIT_NAME}.timer enabled and active."
}

cmd_cert_status() {
  c_blue "Cert info:"
  remote "openssl x509 -in ${TLS_CERT_REMOTE} -noout -enddate -fingerprint -sha256 2>/dev/null || echo '(no cert at ${TLS_CERT_REMOTE})'"
  c_blue "Renewal timer:"
  remote "systemctl list-timers ${RENEW_UNIT_NAME} --no-pager 2>/dev/null || echo '(timer not installed)'"
}

# Idempotently ensure a single KEY=VALUE line in the remote env file. Adds
# the line if absent, updates in place if present. Preserves all other
# entries (notably SUPERADMIN_PASSWORD).
remote_env_upsert() {
  local k="$1" v="$2"
  remote "sudo bash -c '
    set -e
    f=${ENV_FILE_REMOTE}
    test -f \$f || { echo \"missing \$f\" >&2; exit 1; }
    if grep -q \"^${k}=\" \"\$f\"; then
      sed -i \"s|^${k}=.*|${k}=${v}|\" \"\$f\"
    else
      printf \"%s=%s\n\" \"${k}\" \"${v}\" >> \"\$f\"
    fi
  '"
}

cmd_apply_tls_env() {
  c_blue "Writing TLS_CERT_PATH / TLS_KEY_PATH into ${ENV_FILE_REMOTE} ..."
  remote_env_upsert "TLS_CERT_PATH" "${TLS_CERT_REMOTE}"
  remote_env_upsert "TLS_KEY_PATH"  "${TLS_KEY_REMOTE}"
  c_grn "Env updated."
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
  c_blue "Curling https://127.0.0.1:${PORT}/ on remote (TLS, -k) ..."
  if remote "curl -k -sS -o /dev/null -w 'HTTPS %{http_code} (size=%{size_download})\n' https://127.0.0.1:${PORT}/"; then
    return 0
  fi
  c_red "HTTPS local probe failed; falling back to plain HTTP probe."
  remote "curl -sS -o /dev/null -w 'HTTP %{http_code} (size=%{size_download})\n' http://127.0.0.1:${PORT}/" || return 1
}

verify_http_public() {
  c_blue "Curling https://${HOST}:${PORT}/ from local (TLS, -k) ..."
  local out
  if out="$(curl -k --noproxy '*' -sS --max-time 8 -o /dev/null -w 'HTTPS %{http_code}' "https://${HOST}:${PORT}/" 2>&1)" && [[ "$out" == *"200"* ]]; then
    c_grn "Public HTTPS reachable: ${out}"
    return 0
  else
    c_red "Public HTTPS NOT reachable: ${out}"
    c_red "If TLS is intentionally off, fall back: curl http://${HOST}:${PORT}/"
    c_red "Otherwise check Aliyun ECS Security Group inbound TCP/${PORT}."
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
    gen-cert)  cmd_gen_cert ;;
    cert-status) cmd_cert_status ;;
    install-cert-renew) cmd_install_cert_renew_unit ;;
    verify)    verify_listen; verify_http_local_remote; verify_http_public ;;
    *) echo "Usage: $0 {bootstrap|sync|restart|status|logs|verify|gen-cert|cert-status|install-cert-renew|full}" >&2; exit 1 ;;
  esac
}

main "$@"
