#!/bin/bash
set -euo pipefail
SESSION_NAME="${TMUXGO_DEFAULT_SESSION:-default}"
if tmux has-session -t "$SESSION_NAME" >/dev/null 2>&1; then
  exit 0
fi
tmux new-session -d -s "$SESSION_NAME"
