#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC_DIR="$ROOT_DIR/deploy/launchd-user"
PLIST_DST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/TmuxGo"
NPM_BIN="$(command -v npm)"
TMUX_BIN="$(command -v tmux)"
SERVICE_PATH="${PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
HOST_NAME="$(scutil --get LocalHostName 2>/dev/null || hostname)"
launchd_domain() {
  local uid
  uid="$(id -u)"
  if launchctl print "gui/$uid" >/dev/null 2>&1; then
    echo "gui/$uid"
    return
  fi
  echo "user/$uid"
}
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}
render_plist() {
  local src=$1
  local dst=$2
  sed \
    -e "s|__TMUXGO_ROOT__|$ROOT_DIR_XML|g" \
    -e "s|__TMUXGO_NPM__|$NPM_BIN_XML|g" \
    -e "s|__TMUXGO_TMUX__|$TMUX_BIN_XML|g" \
    -e "s|__TMUXGO_PATH__|$SERVICE_PATH_XML|g" \
    -e "s|__TMUXGO_LOG_DIR__|$LOG_DIR_XML|g" \
    -e "s|__TMUXGO_HOST_NAME__|$HOST_NAME_XML|g" \
    "$src" > "$dst"
}
bootout_plist() {
  local label=$1
  local plist=$2
  local domain
  domain="$(launchd_domain)"
  launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
}
bootstrap_plist() {
  local label=$1
  local plist=$2
  local domain
  domain="$(launchd_domain)"
  bootout_plist "$label" "$plist"
  launchctl bootstrap "$domain" "$plist"
  launchctl enable "$domain/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
}
if [ "$(uname -s)" != "Darwin" ]; then
  echo "launchd is only available on macOS"
  exit 1
fi
mkdir -p "$PLIST_DST_DIR" "$LOG_DIR" "$HOME/tmux_backups"
ROOT_DIR_XML="$(escape_sed_replacement "$(xml_escape "$ROOT_DIR")")"
NPM_BIN_XML="$(escape_sed_replacement "$(xml_escape "$NPM_BIN")")"
TMUX_BIN_XML="$(escape_sed_replacement "$(xml_escape "$TMUX_BIN")")"
SERVICE_PATH_XML="$(escape_sed_replacement "$(xml_escape "$SERVICE_PATH")")"
LOG_DIR_XML="$(escape_sed_replacement "$(xml_escape "$LOG_DIR")")"
HOST_NAME_XML="$(escape_sed_replacement "$(xml_escape "$HOST_NAME")")"
render_plist "$PLIST_SRC_DIR"/com.tmuxgo.frontend.plist "$PLIST_DST_DIR"/com.tmuxgo.frontend.plist
render_plist "$PLIST_SRC_DIR"/com.tmuxgo.gateway.plist "$PLIST_DST_DIR"/com.tmuxgo.gateway.plist
render_plist "$PLIST_SRC_DIR"/com.tmuxgo.agent.plist "$PLIST_DST_DIR"/com.tmuxgo.agent.plist
cd "$ROOT_DIR"
npm install
npm run build:gateway
env NEXT_DIST_DIR=.next-prod npm run build:frontend
npm run build:agent
"$TMUX_BIN" has-session -t default >/dev/null 2>&1 || "$TMUX_BIN" new-session -d -s default >/dev/null 2>&1 || true
bootstrap_plist com.tmuxgo.gateway "$PLIST_DST_DIR"/com.tmuxgo.gateway.plist
bootstrap_plist com.tmuxgo.frontend "$PLIST_DST_DIR"/com.tmuxgo.frontend.plist
bootstrap_plist com.tmuxgo.agent "$PLIST_DST_DIR"/com.tmuxgo.agent.plist
