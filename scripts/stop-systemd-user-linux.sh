#!/bin/bash
set -euo pipefail
systemctl --user disable --now tmuxgo.target 2>/dev/null || true
systemctl --user disable --now tmuxgo-gateway.service 2>/dev/null || true
systemctl --user disable --now tmuxgo-frontend.service 2>/dev/null || true
systemctl --user disable --now tmuxgo-agent.service 2>/dev/null || true
