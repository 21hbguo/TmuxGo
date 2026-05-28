#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_FILE="/tmp/tmuxgo-start.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another start.sh is running, skip."
  exit 1
fi
cd "$ROOT_DIR"
echo "Starting TmuxGo development servers..."
RESTART=0
REBUILD_STABLE=0
for arg in "$@"; do
  if [ "$arg" = "--restart" ]; then
    RESTART=1
  fi
  if [ "$arg" = "--rebuild" ]; then
    REBUILD_STABLE=1
  fi
done
FRONTEND_STABLE_LOG="/tmp/tmuxgo-frontend-stable.log"
FRONTEND_DEV_LOG="/tmp/tmuxgo-frontend-dev.log"
GATEWAY_LOG="/tmp/tmuxgo-gateway.log"
AGENT_LOG="/tmp/tmuxgo-agent.log"
FRONTEND_STABLE_DIST_DIR=".next-prod"
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
  ss -ltn "( sport = :$1 )" 2>/dev/null | tail -n +2 | rg -q . || lsof -i :"$1" >/dev/null 2>&1
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
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true) $(fuser -n tcp "$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
  fi
}
wait_port_free() {
  local port=$1
  for i in $(seq 1 30); do
    if ! lsof -i :"$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  # port still occupied, force kill again
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true) $(fuser -n tcp "$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
  if lsof -i :"$port" >/dev/null 2>&1; then
    echo "Warning: port $port still in use"
  fi
}
start_detached() {
  local log_file=$1
  shift
  setsid nohup "$@" 9>&- > "$log_file" 2>&1 < /dev/null &
  echo $!
}
process_alive() {
  local pid=$1
  kill -0 "$pid" >/dev/null 2>&1
}
stable_build_ready() {
  [ -f "$ROOT_DIR/apps/frontend/$FRONTEND_STABLE_DIST_DIR/BUILD_ID" ]
}
agent_running() {
  pgrep -af "npm run dev:agent" >/dev/null 2>&1
}
stop_existing() {
  pkill -f "$ROOT_DIR/node_modules/.bin/next .*--port 3000" 2>/dev/null || true
  pkill -f "$ROOT_DIR/node_modules/.bin/next .*--port 3002" 2>/dev/null || true
  pkill -f "next start --hostname 0.0.0.0 --port 3000" 2>/dev/null || true
  pkill -f "next dev --hostname 0.0.0.0 --port 3002" 2>/dev/null || true
  pkill -f "$ROOT_DIR/node_modules/.bin/tsx watch src/index.ts" 2>/dev/null || true
  kill_port 3000
  kill_port 3002
  kill_port 3001
  for i in $(seq 1 20); do
    if ! pgrep -af "$ROOT_DIR/node_modules/.bin/next start --hostname 0.0.0.0 --port 3000" >/dev/null 2>&1 && ! pgrep -af "$ROOT_DIR/node_modules/.bin/next dev --hostname 0.0.0.0 --port 3002" >/dev/null 2>&1 && ! pgrep -af "$ROOT_DIR/node_modules/.bin/tsx watch src/index.ts" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
  wait_port_free 3000
  wait_port_free 3001
  wait_port_free 3002
}
if [ "$RESTART" = "1" ]; then
  stop_existing
fi
if ! port_in_use 3001; then
  rm -f "$GATEWAY_LOG"
fi
if ! port_in_use 3000; then
  rm -f "$FRONTEND_STABLE_LOG"
fi
if ! port_in_use 3002; then
  rm -f "$FRONTEND_DEV_LOG"
fi
if wait_http_ok "http://127.0.0.1:3001/api/hosts" 1; then
  echo "Gateway already running on port 3001, skipping..."
else
  echo "Starting Gateway on port 3001..."
  GATEWAY_PID=$(start_detached "$GATEWAY_LOG" npm run dev:gateway)
  if wait_http_ok "http://127.0.0.1:3001/api/hosts" 30 && ! rg -q "EADDRINUSE|Failed to start server" "$GATEWAY_LOG"; then
    echo "  Gateway started successfully"
  else
    echo "  Gateway failed to start, check $GATEWAY_LOG"
  fi
fi
if wait_http_ok "http://127.0.0.1:3000" 1; then
  echo "Stable frontend already running on port 3000, skipping..."
else
  if [ "$REBUILD_STABLE" = "1" ] || ! stable_build_ready; then
    if [ "$REBUILD_STABLE" = "1" ]; then
      echo "Rebuilding stable frontend..."
    else
      echo "Stable frontend build missing, building..."
    fi
    if env NEXT_DIST_DIR="$FRONTEND_STABLE_DIST_DIR" npm run build:frontend >/dev/null 2>&1; then
      echo "  Build completed"
    else
      echo "  Build failed, check output by running: env NEXT_DIST_DIR=$FRONTEND_STABLE_DIST_DIR npm run build:frontend"
      exit 1
    fi
  else
    echo "Reusing existing stable frontend build"
  fi
  echo "Starting stable frontend on port 3000..."
  STABLE_PID=$(start_detached "$FRONTEND_STABLE_LOG" env NEXT_DIST_DIR="$FRONTEND_STABLE_DIST_DIR" npm run --workspace=frontend start -- --hostname 0.0.0.0 --port 3000)
  if wait_http_ok "http://127.0.0.1:3000" 45 && ! rg -q "EADDRINUSE|Failed to start server" "$FRONTEND_STABLE_LOG"; then
    echo "  Stable frontend started successfully"
  else
    echo "  Stable frontend failed to start, check $FRONTEND_STABLE_LOG"
  fi
fi
if wait_http_ok "http://127.0.0.1:3002" 1; then
  echo "Dev frontend already running on port 3002, skipping..."
else
  echo "Starting dev frontend on port 3002..."
  DEV_PID=$(start_detached "$FRONTEND_DEV_LOG" env NODE_ENV=development NEXT_DIST_DIR=.next-dev npm run --workspace=frontend dev -- --port 3002)
  if wait_http_ok "http://127.0.0.1:3002" 45 && ! rg -q "EADDRINUSE|Failed to start server" "$FRONTEND_DEV_LOG"; then
    echo "  Dev frontend started successfully"
  else
    echo "  Dev frontend failed to start, check $FRONTEND_DEV_LOG"
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
if agent_running; then
  echo "  Agent already running, skipping..."
else
  rm -f "$AGENT_LOG"
  AGENT_PID=$(start_detached "$AGENT_LOG" npm run dev:agent)
  sleep 2
  if rg -n "Connected to gateway|Registered as agent" "$AGENT_LOG" >/dev/null 2>&1; then
    echo "  Agent started successfully"
  else
    echo "  Agent failed to start, check $AGENT_LOG"
  fi
fi
echo ""
echo "TmuxGo services:"
echo ""
echo "  Frontend stable: http://${TAILSCALE_IP}:3000"
echo "  Frontend dev:    http://${TAILSCALE_IP}:3002"
echo "  Gateway:   http://${TAILSCALE_IP}:3001"
if [ -n "${SECURE_FRONTEND_URL:-}" ]; then
  echo "  Frontend HTTPS: ${SECURE_FRONTEND_URL}"
  echo "  Gateway HTTPS:  ${SECURE_GATEWAY_URL}"
fi
echo ""
echo "Logs:"
echo "  Gateway:   $GATEWAY_LOG"
echo "  Frontend stable: $FRONTEND_STABLE_LOG"
echo "  Frontend dev:    $FRONTEND_DEV_LOG"
echo "  Agent:     $AGENT_LOG"
