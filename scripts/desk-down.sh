#!/bin/bash
# Stop Docker Desk and the Mac progress-scan helper started by desk-up.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="$ROOT/out/progress-scan-host.pid"

docker compose down "$@"

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "stopped progress-scan helper pid=$pid"
  fi
  rm -f "$PID_FILE"
fi
