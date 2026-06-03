#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MAJOR=20
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
cd "$ROOT_DIR"
has_cmd() {
  command -v "$1" >/dev/null 2>&1
}
run_privileged() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
    return
  fi
  if has_cmd sudo; then
    sudo "$@"
    return
  fi
  echo "Missing sudo. Re-run as root or install sudo."
  exit 1
}
node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || true
}
load_nvm() {
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  . "$NVM_DIR/nvm.sh"
}
detect_pkg_manager() {
  if has_cmd apt-get; then
    echo apt-get
    return
  fi
  if has_cmd dnf; then
    echo dnf
    return
  fi
  if has_cmd pacman; then
    echo pacman
    return
  fi
  if has_cmd brew; then
    echo brew
    return
  fi
  echo ""
}
load_brew() {
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    return
  fi
  if [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}
install_linux_packages() {
  case "$1" in
    apt-get)
      run_privileged apt-get update -qq
      run_privileged apt-get install -y -qq curl ca-certificates git python3 build-essential pkg-config ripgrep lsof psmisc iproute2 tmux
      ;;
    dnf)
      run_privileged dnf install -y curl ca-certificates git python3 gcc-c++ make pkgconf-pkg-config ripgrep lsof psmisc iproute tmux
      ;;
    pacman)
      run_privileged pacman -Sy --noconfirm --needed curl ca-certificates git python base-devel pkgconf ripgrep lsof psmisc iproute2 tmux
      ;;
  esac
}
install_brew_packages() {
  load_brew
  brew install curl git python tmux ripgrep pkg-config
}
install_nvm() {
  if ! has_cmd curl; then
    echo "curl is required to install Node.js 20."
    exit 1
  fi
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  fi
  load_nvm
}
ensure_node20() {
  if has_cmd node && has_cmd npm && [ "$(node_major)" = "$NODE_MAJOR" ]; then
    return
  fi
  load_nvm || true
  if ! type nvm >/dev/null 2>&1; then
    install_nvm
  fi
  nvm install "$NODE_MAJOR" >/dev/null
  nvm use "$NODE_MAJOR" >/dev/null
  hash -r
  if ! has_cmd node || ! has_cmd npm || [ "$(node_major)" != "$NODE_MAJOR" ]; then
    echo "Failed to activate Node.js $NODE_MAJOR."
    exit 1
  fi
}
verify_required() {
  local missing=()
  for cmd in git curl python3 tmux rg; do
    if ! has_cmd "$cmd"; then
      missing+=("$cmd")
    fi
  done
  if ! has_cmd lsof && ! has_cmd ss; then
    missing+=("lsof-or-ss")
  fi
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Missing required commands: ${missing[*]}"
    exit 1
  fi
}
if [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
  echo "Install Xcode Command Line Tools first: xcode-select --install"
  exit 1
fi
PKG_MANAGER="$(detect_pkg_manager)"
case "$PKG_MANAGER" in
  apt-get|dnf|pacman)
    install_linux_packages "$PKG_MANAGER"
    ;;
  brew)
    install_brew_packages
    ;;
esac
ensure_node20
if type nvm >/dev/null 2>&1; then
  nvm use "$NODE_MAJOR" >/dev/null 2>&1 || true
fi
verify_required
if has_cmd tailscale && ! tailscale status >/dev/null 2>&1; then
  echo "Tailscale detected but not connected. Run: tailscale up"
fi
npm install
echo "Bootstrap completed"
echo "Run: ./install.sh"
echo "Or: ./start.sh"
