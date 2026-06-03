#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC_DIR="$ROOT_DIR/deploy/systemd-user"
UNIT_DST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}
render_unit() {
  local src=$1
  local dst=$2
  sed "s|__TMUXGO_ROOT__|$ROOT_DIR_ESCAPED|g" "$src" > "$dst"
}
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found"
  exit 1
fi
ROOT_DIR_ESCAPED="$(escape_sed_replacement "$ROOT_DIR")"
mkdir -p "$UNIT_DST_DIR"
render_unit "$UNIT_SRC_DIR"/tmuxgo-frontend.service "$UNIT_DST_DIR"/tmuxgo-frontend.service
render_unit "$UNIT_SRC_DIR"/tmuxgo-gateway.service "$UNIT_DST_DIR"/tmuxgo-gateway.service
render_unit "$UNIT_SRC_DIR"/tmuxgo-agent.service "$UNIT_DST_DIR"/tmuxgo-agent.service
cp "$UNIT_SRC_DIR"/tmuxgo.target "$UNIT_DST_DIR"/
cp "$UNIT_SRC_DIR"/tmux-server.service "$UNIT_DST_DIR"/
mkdir -p "$HOME/tmux_backups"
cd "$ROOT_DIR"
npm install
npm run build:gateway
env NEXT_DIST_DIR=.next-prod npm run build:frontend
npm run build:agent
systemctl --user daemon-reload
systemctl --user enable tmuxgo.target
systemctl --user enable tmuxgo-gateway.service
systemctl --user enable tmuxgo-frontend.service
systemctl --user enable tmuxgo-agent.service
systemctl --user enable tmux-server.service
systemctl --user start tmux-server.service
systemctl --user start tmuxgo-gateway.service
systemctl --user start tmuxgo-frontend.service
systemctl --user start tmuxgo-agent.service
