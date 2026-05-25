#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}
need_cmd node
need_cmd npm
need_cmd tmux
if command -v nvm >/dev/null 2>&1; then
  nvm use >/dev/null 2>&1 || true
fi
if command -v tailscale >/dev/null 2>&1; then
  if ! tailscale status >/dev/null 2>&1; then
    echo "Tailscale detected but not connected. Run: tailscale up"
  fi
fi
npm install
echo "Bootstrap completed"
echo "Run: bash start.sh"
