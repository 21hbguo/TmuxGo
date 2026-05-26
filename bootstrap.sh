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
install_tmux() {
  if command -v tmux >/dev/null 2>&1; then return; fi
  echo "tmux not found, installing..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq tmux
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y tmux
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm tmux
  elif command -v brew >/dev/null 2>&1; then
    brew install tmux
  else
    echo "Cannot install tmux automatically. Please install it manually."
    exit 1
  fi
}
need_cmd node
need_cmd npm
install_tmux
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
