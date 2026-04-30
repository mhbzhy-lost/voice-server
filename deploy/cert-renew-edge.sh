#!/usr/bin/env bash
# voice-server EDGE self-signed TLS cert renewal — runs on the US edge host.
#
# Single source of truth shared by:
#   - systemd timer (voice-edge-cert-renew.timer)
#   - manual invocation
#
# Reads /etc/voice-edge.env for TLS_CERT_PATH, TLS_KEY_PATH, VOICE_EDGE_SAN_HOST.
# Renews when: cert missing OR expiring within 30 days OR SAN missing IP.
# Pass --force to skip checks and unconditionally regenerate.
#
# On renewal, restarts voice-edge-stun.service AND reloads nginx (which
# also serves the cert for HTTPS termination on :3000).
set -euo pipefail

ENV_FILE="/etc/voice-edge.env"
RENEW_BEFORE_SECONDS=$((30 * 24 * 3600))
CERT_DAYS=397
STUN_SERVICE="voice-edge-stun.service"

log() { printf '[cert-renew-edge] %s\n' "$*" >&2; }
die() { printf '[cert-renew-edge][error] %s\n' "$*" >&2; exit 1; }

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
SAN_HOST="${VOICE_EDGE_SAN_HOST:-}"
[ -n "$CERT" ]     || die "TLS_CERT_PATH not set in $ENV_FILE"
[ -n "$KEY" ]      || die "TLS_KEY_PATH not set in $ENV_FILE"
[ -n "$SAN_HOST" ] || die "VOICE_EDGE_SAN_HOST not set in $ENV_FILE"

CERT_DIR="$(dirname "$CERT")"
OWNER="${VOICE_EDGE_OWNER:-$(stat -c '%U' "$CERT_DIR" 2>/dev/null || echo root)}"
GROUP="${VOICE_EDGE_GROUP:-$OWNER}"

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
  -subj "/CN=voice-edge.local" \
  -addext "subjectAltName=IP:${SAN_HOST},DNS:voice-edge.local" >/dev/null 2>&1

mv -f "$TMP_KEY" "$KEY"
mv -f "$TMP_CERT" "$CERT"
trap - EXIT

chown "${OWNER}:${GROUP}" "$KEY" "$CERT"
chmod 600 "$KEY"
chmod 644 "$CERT"
# nginx (running as its own user) must be able to read both files
chmod 644 "$CERT"
chmod 640 "$KEY" || true

fp="$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 2>/dev/null || true)"
notafter="$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
log "new cert ${fp}"
log "new cert valid until ${notafter}"

systemctl restart "$STUN_SERVICE" 2>/dev/null || log "warn: failed to restart ${STUN_SERVICE}"
systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || log "warn: failed to reload nginx"
log "ok cert renewed; stun restarted; nginx reloaded"
echo "[ok] cert renewed; stun restarted; nginx reloaded"
