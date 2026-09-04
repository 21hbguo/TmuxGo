#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
find node_modules -type f \( -name '*.node' -o -name 'spawn-helper' -o -name 'esbuild' -o -name 'swc' \) ! -perm -u+x -exec chmod 755 {} +
