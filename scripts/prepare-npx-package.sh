#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$ROOT_DIR/apps/cli"
cd "$ROOT_DIR"
npm run build:gateway
npm run build:frontend
rm -rf "$CLI_DIR/vendor"
mkdir -p "$CLI_DIR/vendor"
cp -R "$ROOT_DIR/apps/gateway/dist" "$CLI_DIR/vendor/gateway"
find "$CLI_DIR/vendor/gateway" -type f \( -name '*.test.js' -o -name '*.d.ts' -o -name '*.map' \) -delete
cp -R "$ROOT_DIR/apps/frontend/dist" "$CLI_DIR/vendor/frontend"
