#!/bin/bash
# One dogfood path: Docker Desk + Mac progress-scan helper.
# Not a LaunchAgent. Scan stays on the host; compose mounts ./data so cron
# can consume data/progress-snapshot.json. Ctrl-C is desk-down.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/out"

PID_FILE="$ROOT/out/progress-scan-host.pid"
LOG="$ROOT/out/progress-scan-host.log"
HEALTH_URL="http://127.0.0.1:${ATOM_PROGRESS_SCAN_PORT:-8788}/health"

helper_alive() {
  if curl -sfS -o /dev/null --max-time 1 "$HEALTH_URL"; then
    return 0
  fi
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

if helper_alive; then
  echo "progress-scan helper already running"
else
  echo "starting host progress-scan helper (git/gh on this Mac → data/progress-snapshot.json)"
  nohup pnpm atom progress-scan --loop >> "$LOG" 2>&1 &
  echo $! > "$PID_FILE"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sfS -o /dev/null --max-time 1 "$HEALTH_URL"; then
      break
    fi
    sleep 0.3
  done
  if helper_alive; then
    echo "progress-scan helper pid=$(cat "$PID_FILE") log=$LOG"
  else
    echo "warn: helper did not become healthy yet — file watch may still work. See $LOG" >&2
  fi
fi

docker compose up -d "$@"
echo "Desk: http://127.0.0.1:8787"
echo "First in-window [cron:poll-yzj-15m] tick refreshes progress-snapshot.json (≤15m, or ~1.5s after listen)."
echo "Stop: scripts/desk-down.sh  (or pnpm desk:down)"
