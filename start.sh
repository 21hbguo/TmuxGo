#!/bin/bash
set -euo pipefail
ROOT_DIR="/home/guo/project/other/tmuxU_20260523"
LOCK_FILE="/tmp/tmuxu-start.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another start.sh is running, skip."
  exit 1
fi
cd "$ROOT_DIR"
echo "Starting tmuxU development servers..."
FRONTEND_LOG="/tmp/tmuxu-frontend.log"
GATEWAY_LOG="/tmp/tmuxu-gateway.log"
AGENT_LOG="/tmp/tmuxu-agent.log"
TAILSCALE_DNS=""
SECURE_FRONTEND_URL=""
SECURE_GATEWAY_URL=""
if command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_IP=$(tailscale ip -4 2>/dev/null | head -n 1 || true)
  TAILSCALE_DNS=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; data=json.load(sys.stdin); print((data.get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null || true)
fi
if [ -z "${TAILSCALE_IP:-}" ]; then
  TAILSCALE_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
if [ -z "${TAILSCALE_IP:-}" ]; then
  TAILSCALE_IP="localhost"
fi
if [ -n "${TAILSCALE_DNS:-}" ]; then
  SECURE_FRONTEND_URL="https://${TAILSCALE_DNS}"
  SECURE_GATEWAY_URL="https://${TAILSCALE_DNS}:8443"
fi
port_in_use() {
  lsof -i :"$1" >/dev/null 2>&1
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
kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
  fi
}
start_detached() {
  local log_file=$1
  shift
  setsid nohup "$@" 9>&- > "$log_file" 2>&1 < /dev/null &
}
stop_existing() {
  pkill -f "$ROOT_DIR/node_modules/.bin/next dev --hostname 0.0.0.0" 2>/dev/null || true
  pkill -f "$ROOT_DIR/node_modules/.bin/tsx watch src/index.ts" 2>/dev/null || true
  kill_port 3000
  kill_port 3001
  for i in $(seq 1 20); do
    if ! pgrep -af "$ROOT_DIR/node_modules/.bin/next dev --hostname 0.0.0.0" >/dev/null 2>&1 && ! pgrep -af "$ROOT_DIR/node_modules/.bin/tsx watch src/index.ts" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
}
stop_existing
rm -f "$FRONTEND_LOG" "$GATEWAY_LOG" "$AGENT_LOG"
rm -rf "$ROOT_DIR/apps/frontend/.next"
if port_in_use 3001; then
  echo "Gateway already running on port 3001, skipping..."
else
  echo "Starting Gateway on port 3001..."
  start_detached "$GATEWAY_LOG" npm run dev:gateway
  if wait_http_ok "http://127.0.0.1:3001/api/hosts" 30; then
    echo "  Gateway started successfully"
  else
    echo "  Gateway failed to start, check $GATEWAY_LOG"
  fi
fi
if port_in_use 3000; then
  echo "Frontend already running on port 3000, skipping..."
else
  echo "Starting Frontend on port 3000..."
  if [ -n "${SECURE_GATEWAY_URL:-}" ]; then
    start_detached "$FRONTEND_LOG" env NEXT_PUBLIC_API_URL="${SECURE_GATEWAY_URL}" npm run dev:frontend
  else
    start_detached "$FRONTEND_LOG" env NEXT_PUBLIC_API_URL="http://${TAILSCALE_IP}:3001" npm run dev:frontend
  fi
  if wait_http_ok "http://127.0.0.1:3000" 45; then
    echo "  Frontend started successfully"
  else
    echo "  Frontend failed to start, check $FRONTEND_LOG"
  fi
fi
if [ -n "${TAILSCALE_DNS:-}" ]; then
  if tailscale serve --yes --bg --https=443 http://127.0.0.1:3000 >/dev/null 2>&1 && tailscale serve --yes --bg --https=8443 http://127.0.0.1:3001 >/dev/null 2>&1; then
    echo "  Tailscale HTTPS enabled"
  else
    echo "  Tailscale HTTPS setup failed"
  fi
fi
echo "Starting Agent..."
start_detached "$AGENT_LOG" npm run dev:agent
sleep 2
if pgrep -af "$ROOT_DIR/node_modules/.bin/tsx watch src/index.ts" | rg -q '/apps/agent/'; then
  echo "  Agent started successfully"
else
  if rg -n "Connected to gateway|registered" "$AGENT_LOG" >/dev/null 2>&1; then
    echo "  Agent started successfully"
  else
    echo "  Agent failed to start, check $AGENT_LOG"
  fi
fi
echo ""
echo "tmuxU services:"
echo ""
echo "  Frontend:  http://${TAILSCALE_IP}:3000"
echo "  Gateway:   http://${TAILSCALE_IP}:3001"
if [ -n "${SECURE_FRONTEND_URL:-}" ]; then
  echo "  Frontend HTTPS: ${SECURE_FRONTEND_URL}"
  echo "  Gateway HTTPS:  ${SECURE_GATEWAY_URL}"
fi
echo ""
echo "Logs:"
echo "  Gateway:   $GATEWAY_LOG"
echo "  Frontend:  $FRONTEND_LOG"
echo "  Agent:     $AGENT_LOG"
