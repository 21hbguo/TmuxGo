#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
has_cmd() {
  command -v "$1" >/dev/null 2>&1
}
wait_http_ok() {
  local url=$1
  local retry=$2
  for i in $(seq 1 "$retry"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}
systemd_user_ready() {
  has_cmd systemctl || return 1
  systemctl --user show-environment >/dev/null 2>&1 || systemctl --user daemon-reload >/dev/null 2>&1
}
launchd_user_ready() {
  [ "$(uname -s)" = "Darwin" ] || return 1
  has_cmd launchctl
}
resolve_host() {
  local host_ip
  host_ip="$(python3 -c 'import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(0); s.connect(("8.8.8.8",80)); print(s.getsockname()[0]); s.close()' 2>/dev/null || true)"
  if [ -z "$host_ip" ]; then
    host_ip="localhost"
  fi
  echo "$host_ip"
}
resolve_tailscale_dns() {
  if ! command -v tailscale >/dev/null 2>&1; then
    return
  fi
  tailscale status --json 2>/dev/null | python3 -c 'import json,sys; data=json.load(sys.stdin); print((data.get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null || true
}
"$ROOT_DIR/bootstrap.sh"
if systemd_user_ready; then
  "$ROOT_DIR/scripts/install-systemd-user-linux.sh"
elif launchd_user_ready; then
  "$ROOT_DIR/scripts/install-launchd-user-mac.sh"
else
  "$ROOT_DIR/start.sh" --restart --rebuild
fi
if ! wait_http_ok "http://127.0.0.1:3001/api/hosts" 90; then
  echo "Gateway health check failed."
  exit 1
fi
if ! wait_http_ok "http://127.0.0.1:3001" 90; then
  echo "Frontend health check failed."
  exit 1
fi
HOST_IP="$(resolve_host)"
TAILSCALE_DNS="$(resolve_tailscale_dns)"
echo ""
echo "TmuxGo installed"
echo "Frontend: http://$HOST_IP:3001"
echo "Gateway: http://$HOST_IP:3001"
if [ -n "$TAILSCALE_DNS" ]; then
  echo "Frontend HTTPS: https://$TAILSCALE_DNS"
  echo "Gateway HTTPS: https://$TAILSCALE_DNS:8443"
fi
