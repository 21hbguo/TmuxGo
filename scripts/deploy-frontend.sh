#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

extract_buildId() {
  printf '%s' "$1" | sed -n 's/.*"buildId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

npm run build:frontend

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user restart tmuxgo-gateway
  echo "Restarted tmuxgo-gateway via systemctl --user."
else
  echo "systemctl --user unavailable. Run: ./start.sh --restart"
fi

# 重启后短暂等待，再对比本地与线上 buildId
local_json="$(cat apps/frontend/dist/version.json 2>/dev/null || true)"
remote_json=""
for _ in 1 2 3 4 5; do
  remote_json="$(curl -sS --max-time 2 http://127.0.0.1:3001/version.json 2>/dev/null || true)"
  if [ -n "$remote_json" ]; then
    break
  fi
  sleep 1
done
echo "Local buildId:  $(extract_buildId "$local_json")"
echo "Served buildId: $(extract_buildId "$remote_json")"
