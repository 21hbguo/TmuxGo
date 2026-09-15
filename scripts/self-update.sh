#!/bin/bash
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_PATH="${1:-}"
if [ -z "$STATE_PATH" ]; then
  echo "usage: self-update.sh <state-path>" >&2
  exit 2
fi
LOG_PATH="${STATE_PATH%.*}.log"
if [ "${TMUXGO_UPDATE_SCOPE:-}" != "1" ] && command -v systemd-run >/dev/null 2>&1; then
  if systemd-run --user --scope --quiet --collect true >/dev/null 2>&1; then
    exec systemd-run --user --scope --quiet --collect --unit="tmuxgo-self-update-$$" env TMUXGO_UPDATE_SCOPE=1 bash "$ROOT_DIR/scripts/self-update.sh" "$STATE_PATH"
  fi
fi
mkdir -p "$(dirname "$LOG_PATH")"
: > "$LOG_PATH"
exec >>"$LOG_PATH" 2>&1
cd "$ROOT_DIR"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
finalize() {
  local code="$1"
  if ! command -v python3 >/dev/null 2>&1; then
    printf '{"status":"%s","finishedAt":"%s","exitCode":%s,"summaryLines":[],"errorMessage":null}\n' "$([ "$code" = "0" ] && echo success || echo error)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" > "$STATE_PATH"
    return
  fi
  python3 - "$STATE_PATH" "$code" "$LOG_PATH" "$STARTED_AT" <<'PY' 2>/dev/null || true
import json,os,sys,datetime
state_path,code,log_path,started=sys.argv[1],int(sys.argv[2]),sys.argv[3],sys.argv[4]
try:
    lines=[l.rstrip() for l in open(log_path,errors='replace').read().splitlines() if l.strip()][-20:]
except Exception:
    lines=[]
existing={}
try:
    existing=json.load(open(state_path))
except Exception:
    pass
state={'status':'success' if code==0 else 'error','startedAt':existing.get('startedAt') or started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'summaryLines':lines,'exitCode':code,'errorMessage':None if code==0 else 'Command exited with code %d'%code,'pid':existing.get('pid')}
tmp='%s.tmp-%d'%(state_path,os.getpid())
with open(tmp,'w') as f:
    f.write(json.dumps(state)+'\n')
os.chmod(tmp,0o600)
os.replace(tmp,state_path)
os.chmod(state_path,0o600)
PY
}
die() {
  local code="$1"
  finalize "$code"
  exit "$code"
}
echo "[update] fetching latest changes..."
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -n "$UPSTREAM" ]; then
  REMOTE="${UPSTREAM%%/*}"
  git fetch --quiet "$REMOTE" || die 1
  TARGET="$UPSTREAM"
else
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  git fetch --quiet origin "${BRANCH:-HEAD}" || die 1
  TARGET="FETCH_HEAD"
fi
LOCAL="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "$TARGET")"
if [ "$LOCAL" = "$REMOTE_SHA" ]; then
  echo "[update] already up to date (${LOCAL:0:7})"
  finalize 0
  exit 0
fi
echo "[update] incoming commits:"
git log --oneline "$LOCAL..$TARGET" | head -10
if ! git merge --ff-only "$TARGET"; then
  echo "[update] fast-forward failed; local history diverged or files are modified"
  die 1
fi
NEW_HEAD="$(git rev-parse HEAD)"
if git diff --name-only "$LOCAL" "$NEW_HEAD" | grep -qE '(^|/)(package(-lock)?\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$'; then
  echo "[update] dependencies changed, running npm install..."
  npm install --no-audit --no-fund || die 1
fi
echo "[update] rebuilding and restarting services..."
./start.sh --restart --rebuild --preserve-tmux
code=$?
finalize "$code"
exit "$code"
