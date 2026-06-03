#!/bin/bash
set -euo pipefail
PLIST_DST_DIR="$HOME/Library/LaunchAgents"
launchd_domain() {
  local uid
  uid="$(id -u)"
  if launchctl print "gui/$uid" >/dev/null 2>&1; then
    echo "gui/$uid"
    return
  fi
  echo "user/$uid"
}
bootout_plist() {
  local label=$1
  local plist=$2
  local domain
  domain="$(launchd_domain)"
  launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
}
if [ "$(uname -s)" = "Darwin" ]; then
  bootout_plist com.tmuxgo.agent "$PLIST_DST_DIR"/com.tmuxgo.agent.plist
  bootout_plist com.tmuxgo.frontend "$PLIST_DST_DIR"/com.tmuxgo.frontend.plist
  bootout_plist com.tmuxgo.gateway "$PLIST_DST_DIR"/com.tmuxgo.gateway.plist
fi
