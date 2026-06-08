#!/bin/bash
set -euo pipefail
UNIT_DST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
systemctl --user disable --now tmuxgo.target 2>/dev/null || true
systemctl --user disable --now tmuxgo-gateway.service 2>/dev/null || true
systemctl --user disable --now tmuxgo-frontend.service 2>/dev/null || true
systemctl --user disable --now tmuxgo-agent.service 2>/dev/null || true
rm -f "$UNIT_DST_DIR"/tmuxgo.target
rm -f "$UNIT_DST_DIR"/tmuxgo-gateway.service
rm -f "$UNIT_DST_DIR"/tmuxgo-frontend.service
rm -f "$UNIT_DST_DIR"/tmuxgo-agent.service
systemctl --user daemon-reload
