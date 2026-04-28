#!/usr/bin/env bash
# voice-server self-signed TLS cert renewal — runs on the remote host.
#
# Single source of truth shared by:
#   - systemd timer (voice-server-cert-renew.timer)
#   - manual `deploy.sh gen-cert`
#
# Reads /etc/voice-server.env for TLS_CERT_PATH, TLS_KEY_PATH, VOICE_SAN_HOST.
# Renews when: cert missing OR expiring within 30 days OR SAN missing IP.
# Pass --force to skip checks and unconditionally regenerate.
#
# All informational output goes to stderr so journalctl entries are clean.
set -euo pipefail

ENV_FILE="/etc/voice-server.env"
RENEW_BEFORE_SECONDS=$((30 * 24 * 3600))
CERT_DAYS=397
SERVICE_NAME="voice-server"

log() { printf '[cert-renew] %s\n' "$*" >&2; }
die() { printf '[cert-renew][error] %s\n' "$*" >&2; exit 1; }

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) die "unknown arg: $arg" ;;
  esac
done

[ -f "$ENV_FILE" ] || die "missing $ENV_FILE"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

CERT="${TLS_CERT_PATH:-}"
KEY="${TLS_KEY_PATH:-}"
SAN_HOST="${VOICE_SAN_HOST:-}"
[ -n "$CERT" ]     || die "TLS_CERT_PATH not set in $ENV_FILE"
[ -n "$KEY" ]      || die "TLS_KEY_PATH not set in $ENV_FILE"
[ -n "$SAN_HOST" ] || die "VOICE_SAN_HOST not set in $ENV_FILE"

# Determine the unix user that should own the cert files. Prefer an explicit
# VOICE_OWNER env override; otherwise use the directory owner of the cert dir.
CERT_DIR="$(dirname "$CERT")"
OWNER="${VOICE_OWNER:-$(stat -c '%U' "$CERT_DIR" 2>/dev/null || echo root)}"
GROUP="${VOICE_GROUP:-$OWNER}"

need_gen=0
reason=""
if [ "$FORCE" = "1" ]; then
  need_gen=1; reason="--force"
elif [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  need_gen=1; reason="cert/key missing"
elif ! openssl x509 -in "$CERT" -noout -checkend "$RENEW_BEFORE_SECONDS" >/dev/null 2>&1; then
  need_gen=1; reason="expires within 30 days"
elif ! openssl x509 -in "$CERT" -noout -text 2>/dev/null | grep -q "IP Address:${SAN_HOST}"; then
  need_gen=1; reason="SAN missing IP:${SAN_HOST}"
fi

if [ "$need_gen" = "0" ]; then
  notafter="$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
  log "ok cert valid until ${notafter}; no action"
  echo "[ok] cert valid until ${notafter}; no action"
  exit 0
fi

log "renewing cert (reason: ${reason})"
mkdir -p "$CERT_DIR"

umask 077
TMP_KEY="${KEY}.new.$$"
TMP_CERT="${CERT}.new.$$"
trap 'rm -f "$TMP_KEY" "$TMP_CERT"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days "$CERT_DAYS" \
  -keyout "$TMP_KEY" -out "$TMP_CERT" \
  -subj "/CN=voice-server.local" \
  -addext "subjectAltName=IP:${SAN_HOST},DNS:voice-server.local" >/dev/null 2>&1

mv -f "$TMP_KEY" "$KEY"
mv -f "$TMP_CERT" "$CERT"
trap - EXIT

chown "${OWNER}:${GROUP}" "$KEY" "$CERT"
chmod 600 "$KEY"
chmod 644 "$CERT"

fp="$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 2>/dev/null || true)"
notafter="$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
log "new cert ${fp}"
log "new cert valid until ${notafter}"

systemctl restart "$SERVICE_NAME"
log "ok cert renewed; service restarted"
echo "[ok] cert renewed; service restarted"
