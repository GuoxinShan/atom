#!/bin/bash
# DEPRECATED — in-process cron on Desk serve replaced this LaunchAgent.
# Do not reinstall login items. Start Desk with `docker compose up -d` or `pnpm serve`.
set -euo pipefail
export PATH="/Users/kingdee/.grok/bin:/opt/homebrew/bin:/Users/kingdee/.local/bin:/usr/bin:/bin"
ROOT=/Users/kingdee/dev/personal/atom
LOG="$ROOT/out/morning-run.log"
mkdir -p "$ROOT/out"
ts=$(date '+%Y-%m-%d %H:%M:%S %z')
echo "[$ts] DEPRECATED atom-morning-run.sh — use in-process cron on docker compose / pnpm serve (data/triggers.json poll-yzj-15m)" >> "$LOG"
if ! curl -sfS -o /tmp/atom-morning-run.json -w '' \
  -X POST http://127.0.0.1:8787/api/run \
  -H 'content-type: application/json' \
  -d '{"source":"yzj-ai-advance"}'; then
  echo "[$ts] FAIL API down or /api/run error — start Desk (docker compose up -d or pnpm serve)" >> "$LOG"
  exit 1
fi
echo "[$ts] OK $(cat /tmp/atom-morning-run.json)" >> "$LOG"
