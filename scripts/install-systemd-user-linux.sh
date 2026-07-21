#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC_DIR="$ROOT_DIR/deploy/systemd-user"
UNIT_DST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NPM_BIN="$(command -v npm)"
SERVICE_PATH="${PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
TMUXGO_ENABLE_AGENT="${TMUXGO_ENABLE_AGENT:-0}"
agent_enabled() {
  case "$TMUXGO_ENABLE_AGENT" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On) return 0 ;;
  esac
  return 1
}
escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}
render_unit() {
  local src=$1
  local dst=$2
  sed \
    -e "s|__TMUXGO_ROOT__|$ROOT_DIR_ESCAPED|g" \
    -e "s|__TMUXGO_NPM__|$NPM_BIN_ESCAPED|g" \
    -e "s|__TMUXGO_PATH__|$SERVICE_PATH_ESCAPED|g" \
    "$src" > "$dst"
}
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found"
  exit 1
fi
ROOT_DIR_ESCAPED="$(escape_sed_replacement "$ROOT_DIR")"
NPM_BIN_ESCAPED="$(escape_sed_replacement "$NPM_BIN")"
SERVICE_PATH_ESCAPED="$(escape_sed_replacement "$SERVICE_PATH")"
mkdir -p "$UNIT_DST_DIR"
render_unit "$UNIT_SRC_DIR"/tmuxgo-gateway.service "$UNIT_DST_DIR"/tmuxgo-gateway.service
render_unit "$UNIT_SRC_DIR"/tmuxgo-agent.service "$UNIT_DST_DIR"/tmuxgo-agent.service
cp "$UNIT_SRC_DIR"/tmuxgo.target "$UNIT_DST_DIR"/
mkdir -p "$HOME/tmux_backups"
cd "$ROOT_DIR"
npm install
npm run build:gateway
npm run build:frontend
if agent_enabled; then
  npm run build:agent
fi
systemctl --user daemon-reload
systemctl --user enable tmuxgo.target
systemctl --user enable tmuxgo-gateway.service
systemctl --user start tmuxgo-gateway.service
systemctl --user disable --now tmuxgo-frontend.service 2>/dev/null || true
rm -f "$UNIT_DST_DIR"/tmuxgo-frontend.service
if agent_enabled; then
  systemctl --user enable tmuxgo-agent.service
  systemctl --user start tmuxgo-agent.service
else
  systemctl --user disable --now tmuxgo-agent.service 2>/dev/null || true
fi
systemctl --user disable --now tmux-server.service 2>/dev/null || true
rm -f "$UNIT_DST_DIR"/tmux-server.service
systemctl --user daemon-reload
