#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
cleanup() {
pkill -P $$ 2>/dev/null || true
}
trap cleanup EXIT INT TERM
export HOST_ID="${HOST_ID:-agent-local}"
export HOST_NAME="${HOST_NAME:-$(hostname)}"
export GATEWAY_URL="${GATEWAY_URL:-ws://127.0.0.1:3001/api/stream}"
export PORT="${PORT:-3001}"
export NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-prod}"
npm run build:gateway
env NEXT_DIST_DIR="$NEXT_DIST_DIR" npm run build:frontend
npm run build:agent
npm run --workspace=gateway start &
gateway_pid=$!
env NEXT_DIST_DIR="$NEXT_DIST_DIR" npm run --workspace=frontend start -- --hostname 0.0.0.0 --port 3000 &
frontend_pid=$!
npm run --workspace=agent start &
agent_pid=$!
wait -n "$gateway_pid" "$frontend_pid" "$agent_pid"
