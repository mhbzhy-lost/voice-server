#!/usr/bin/env bash
# voice-server EDGE node bootstrap (US ECS).
#
# Provisions an edge node that:
#   - Terminates HTTPS on :3000 via nginx (self-signed IP-SAN cert)
#   - Serves /opt/voice-edge/public as static root with SPA fallback
#   - Reverse-proxies /api/ and /ws to the China-east backend
#   - Runs an independent Node STUN process on UDP :3478
#
# Idempotent. Safe to re-run.
#
# Required .env vars: VOICE_EDGE_HOST, VOICE_EDGE_SSH_USER, VOICE_EDGE_SSH_KEY
# Optional:           VOICE_BACKEND_HOST (defaults to VOICE_HOST)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a; . "$PROJECT_DIR/.env"; set +a
fi

HOST="${VOICE_EDGE_HOST:-}"
USER="${VOICE_EDGE_SSH_USER:-}"
KEY="${VOICE_EDGE_SSH_KEY:-}"
BACKEND_HOST="${VOICE_BACKEND_HOST:-${VOICE_HOST:-}}"

[ -n "$HOST" ]         || { echo "missing VOICE_EDGE_HOST in .env" >&2; exit 1; }
[ -n "$USER" ]         || { echo "missing VOICE_EDGE_SSH_USER in .env" >&2; exit 1; }
[ -n "$KEY" ]          || { echo "missing VOICE_EDGE_SSH_KEY in .env" >&2; exit 1; }
[ -n "$BACKEND_HOST" ] || { echo "missing VOICE_BACKEND_HOST (or VOICE_HOST) in .env" >&2; exit 1; }

REMOTE_DIR="/opt/voice-edge"
ENV_FILE_REMOTE="/etc/voice-edge.env"
TLS_DIR_REMOTE="${REMOTE_DIR}/tls"
TLS_CERT_REMOTE="${TLS_DIR_REMOTE}/cert.pem"
TLS_KEY_REMOTE="${TLS_DIR_REMOTE}/key.pem"
REMOTE_SCRIPTS_DIR="${REMOTE_DIR}/scripts"
REMOTE_RENEW_SCRIPT="${REMOTE_SCRIPTS_DIR}/cert-renew.sh"
NGINX_CONF_REMOTE="/etc/nginx/conf.d/voice-edge.conf"
STUN_UNIT="voice-edge-stun.service"
RENEW_UNIT="voice-edge-cert-renew"
NODE_MAJOR="${NODE_MAJOR:-20}"
NODE_FULL="v20.18.0"

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

c_blue() { printf '\033[1;34m[%s]\033[0m %s\n' "edge-bootstrap" "$*"; }
c_red()  { printf '\033[1;31m[%s]\033[0m %s\n' "edge-bootstrap" "$*" >&2; }
c_grn()  { printf '\033[1;32m[%s]\033[0m %s\n' "edge-bootstrap" "$*"; }

remote() { ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "$@"; }

# ----- Step 1: detect remote OS / package manager -----
c_blue "Detecting remote OS on ${HOST} ..."
OS_ID="$(remote 'awk -F= "/^ID=/{gsub(/\"/,\"\",\$2); print \$2}" /etc/os-release' || echo unknown)"
c_grn "Remote OS ID: ${OS_ID}"

PM=""
case "$OS_ID" in
  ubuntu|debian) PM="apt" ;;
  centos|rhel|rocky|almalinux|anolis|amzn|fedora) PM="dnf" ;;
  *)
    if remote 'command -v apt-get >/dev/null 2>&1'; then PM="apt"
    elif remote 'command -v dnf >/dev/null 2>&1'; then PM="dnf"
    elif remote 'command -v yum >/dev/null 2>&1'; then PM="yum"
    else c_red "no supported package manager found"; exit 1
    fi
    ;;
esac
c_grn "Package manager: ${PM}"

# ----- Step 2: install nginx + utilities -----
c_blue "Installing nginx, openssl, tar, xz, curl, rsync ..."
case "$PM" in
  apt)
    remote "sudo DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null && \
            sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nginx openssl tar xz-utils curl rsync >/dev/null"
    ;;
  dnf)
    remote "sudo dnf install -y nginx openssl tar xz curl rsync >/dev/null"
    ;;
  yum)
    remote "sudo yum install -y nginx openssl tar xz curl rsync >/dev/null"
    ;;
esac
c_grn "Base packages installed."

# ----- Step 3: install Node.js (try nodesource, fall back to npmmirror) -----
if remote "command -v node >/dev/null 2>&1 && node -v | grep -q '^v${NODE_MAJOR}\\.'"; then
  c_grn "Node.js v${NODE_MAJOR}.x already present: $(remote 'node -v')"
else
  c_blue "Installing Node.js v${NODE_MAJOR} ..."
  installed=0
  # Route A: NodeSource (works well from US)
  case "$PM" in
    apt)
      if remote "curl -fsSL --max-time 60 https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash - >/dev/null 2>&1 && \
                 sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null 2>&1"; then
        installed=1
      fi
      ;;
    dnf|yum)
      if remote "curl -fsSL --max-time 60 https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | sudo bash - >/dev/null 2>&1 && \
                 sudo ${PM} install -y nodejs >/dev/null 2>&1"; then
        installed=1
      fi
      ;;
  esac
  # Route B: prebuilt tarball (npmmirror fallback)
  if [ "$installed" != "1" ]; then
    c_red "NodeSource install failed; trying tarball fallback ..."
    if remote "set -e; cd /tmp; A=node-${NODE_FULL}-linux-x64.tar.xz; \
        curl -fsSL --max-time 120 -o \$A https://nodejs.org/dist/${NODE_FULL}/\$A || \
        curl -fsSL --max-time 120 -o \$A https://registry.npmmirror.com/-/binary/node/${NODE_FULL}/\$A; \
        sudo rm -rf /usr/local/lib/nodejs && sudo mkdir -p /usr/local/lib/nodejs && \
        sudo tar -xJf \$A -C /usr/local/lib/nodejs && \
        sudo ln -sf /usr/local/lib/nodejs/node-${NODE_FULL}-linux-x64/bin/node /usr/bin/node && \
        sudo ln -sf /usr/local/lib/nodejs/node-${NODE_FULL}-linux-x64/bin/npm /usr/bin/npm && \
        sudo ln -sf /usr/local/lib/nodejs/node-${NODE_FULL}-linux-x64/bin/npx /usr/bin/npx && \
        rm -f \$A"; then
      installed=1
    fi
  fi
  [ "$installed" = "1" ] || { c_red "All Node install routes failed."; exit 1; }
  c_grn "Node installed: $(remote 'node -v')"
fi

# ----- Step 4: directories -----
c_blue "Creating ${REMOTE_DIR}/{public,tls,scripts,stun} ..."
remote "sudo mkdir -p ${REMOTE_DIR}/public ${TLS_DIR_REMOTE} ${REMOTE_SCRIPTS_DIR} ${REMOTE_DIR}/stun && \
        sudo chown -R ${USER}:${USER} ${REMOTE_DIR} && \
        sudo chmod 755 ${REMOTE_DIR} ${REMOTE_DIR}/public ${TLS_DIR_REMOTE} ${REMOTE_SCRIPTS_DIR} ${REMOTE_DIR}/stun"
c_grn "Directories ready."

# ----- Step 5: rsync static assets -----
c_blue "Rsyncing public/ -> ${HOST}:${REMOTE_DIR}/public/ ..."
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude='.DS_Store' \
  "${PROJECT_DIR}/public/" "${USER}@${HOST}:${REMOTE_DIR}/public/"
c_grn "public/ synced."

# ----- Step 6: rsync STUN code -----
c_blue "Rsyncing stun/ -> ${HOST}:${REMOTE_DIR}/stun/ ..."
rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude='.DS_Store' \
  "${PROJECT_DIR}/stun/" "${USER}@${HOST}:${REMOTE_DIR}/stun/"
c_grn "stun/ synced."

# ----- Step 7: env file -----
c_blue "Writing ${ENV_FILE_REMOTE} ..."
remote "sudo tee ${ENV_FILE_REMOTE} >/dev/null <<EOF
TLS_CERT_PATH=${TLS_CERT_REMOTE}
TLS_KEY_PATH=${TLS_KEY_REMOTE}
VOICE_EDGE_SAN_HOST=${HOST}
VOICE_EDGE_OWNER=${USER}
VOICE_EDGE_GROUP=${USER}
EOF
sudo chown root:${USER} ${ENV_FILE_REMOTE}
sudo chmod 640 ${ENV_FILE_REMOTE}"
c_grn "Env file written."

# ----- Step 8: install cert-renew script + force generate -----
c_blue "Installing cert-renew-edge.sh -> ${REMOTE_RENEW_SCRIPT} ..."
ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee ${REMOTE_RENEW_SCRIPT} >/dev/null" < "${SCRIPT_DIR}/cert-renew-edge.sh"
remote "sudo chown root:root ${REMOTE_RENEW_SCRIPT} && sudo chmod 755 ${REMOTE_RENEW_SCRIPT}"
c_blue "Generating self-signed cert (idempotent; --force on first run if missing) ..."
remote "sudo ${REMOTE_RENEW_SCRIPT}"
c_grn "Cert ready."

# ----- Step 9: nginx config -----
c_blue "Writing nginx config -> ${NGINX_CONF_REMOTE} ..."
sed \
  -e "s|__VOICE_EDGE_SAN_HOST__|${HOST}|g" \
  -e "s|__BACKEND_HOST__|${BACKEND_HOST}|g" \
  -e "s|__SSL_CERT__|${TLS_CERT_REMOTE}|g" \
  -e "s|__SSL_KEY__|${TLS_KEY_REMOTE}|g" \
  "${SCRIPT_DIR}/voice-server-edge.nginx.conf.tmpl" \
  | ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee ${NGINX_CONF_REMOTE} >/dev/null"
remote "sudo chown root:root ${NGINX_CONF_REMOTE} && sudo chmod 644 ${NGINX_CONF_REMOTE}"

# Make sure default site doesn't squat on :3000 (rare but cheap to guard).
remote "sudo nginx -t" || { c_red "nginx config test failed"; exit 1; }
c_grn "nginx config installed and validated."

# Ensure nginx user can read TLS key
NGINX_USER="$(remote "grep -E '^[[:space:]]*user[[:space:]]+' /etc/nginx/nginx.conf | awk '{print \$2}' | tr -d ';' | head -1" || echo "")"
if [ -n "$NGINX_USER" ]; then
  remote "sudo usermod -a -G ${USER} ${NGINX_USER} 2>/dev/null || true"
  remote "sudo chmod 750 ${TLS_DIR_REMOTE} && sudo chmod 640 ${TLS_KEY_REMOTE}"
fi

# ----- Step 10: systemd units -----
c_blue "Installing systemd units ..."
sed "s/__VOICE_EDGE_SSH_USER__/${USER}/g" "${SCRIPT_DIR}/voice-edge-stun.service" \
  | ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee /etc/systemd/system/${STUN_UNIT} >/dev/null"
ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee /etc/systemd/system/${RENEW_UNIT}.service >/dev/null" < "${SCRIPT_DIR}/voice-edge-cert-renew.service"
ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" "sudo tee /etc/systemd/system/${RENEW_UNIT}.timer >/dev/null" < "${SCRIPT_DIR}/voice-edge-cert-renew.timer"
remote "sudo chown root:root /etc/systemd/system/${STUN_UNIT} /etc/systemd/system/${RENEW_UNIT}.service /etc/systemd/system/${RENEW_UNIT}.timer && \
        sudo chmod 644 /etc/systemd/system/${STUN_UNIT} /etc/systemd/system/${RENEW_UNIT}.service /etc/systemd/system/${RENEW_UNIT}.timer && \
        sudo systemctl daemon-reload"
c_grn "systemd units installed."

# ----- Step 11: enable + start -----
c_blue "Enabling and starting nginx, ${STUN_UNIT}, ${RENEW_UNIT}.timer ..."
remote "sudo systemctl enable --now nginx ${STUN_UNIT} ${RENEW_UNIT}.timer"
remote "sudo systemctl reload nginx || sudo systemctl restart nginx"

# ----- Step 12: report -----
echo
c_blue "===== Edge node summary ====="
echo "URL:          https://${HOST}:3000/"
echo "STUN:         stun:${HOST}:3478"
echo "Backend:      https://${BACKEND_HOST}:3000  (proxied via /api/, /ws)"
echo
echo "Cert fingerprint:"
remote "sudo openssl x509 -in ${TLS_CERT_REMOTE} -noout -fingerprint -sha256 -enddate" || true
echo
echo "Service status:"
remote "systemctl is-active nginx ${STUN_UNIT} ${RENEW_UNIT}.timer 2>/dev/null | paste -d' ' - - - | sed 's/^/  /'" || \
  remote "systemctl is-active nginx; systemctl is-active ${STUN_UNIT}; systemctl is-active ${RENEW_UNIT}.timer"
echo
c_grn "Edge bootstrap complete."
