#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC_DIR="$ROOT_DIR/deploy/systemd-user"
UNIT_DST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DST_DIR"
cp "$UNIT_SRC_DIR"/tmuxgo-frontend.service "$UNIT_DST_DIR"/
cp "$UNIT_SRC_DIR"/tmuxgo-gateway.service "$UNIT_DST_DIR"/
cp "$UNIT_SRC_DIR"/tmuxgo-agent.service "$UNIT_DST_DIR"/
cp "$UNIT_SRC_DIR"/tmuxgo.target "$UNIT_DST_DIR"/
cd "$ROOT_DIR"
npm install
npm run build
systemctl --user daemon-reload
systemctl --user enable tmuxgo.target
systemctl --user restart tmuxgo-gateway.service
systemctl --user restart tmuxgo-frontend.service
systemctl --user restart tmuxgo-agent.service
systemctl --user start tmuxgo.target
