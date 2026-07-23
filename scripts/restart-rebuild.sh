#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
COMMIT_MSG="${1:-chore: restart and rebuild}"
git add -A
if git diff --cached --quiet; then
  echo "No staged changes to commit."
else
  git commit -m "$COMMIT_MSG"
fi
exec "$ROOT_DIR/../start.sh" --restart --rebuild
