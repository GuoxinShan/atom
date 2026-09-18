#!/bin/bash
set -euo pipefail
export PATH="/Users/kingdee/.grok/bin:/opt/homebrew/bin:/Users/kingdee/.local/bin:/usr/bin:/bin"
ROOT=/Users/kingdee/dev/personal/atom
LOG="$ROOT/out/morning-run.log"
mkdir -p "$ROOT/out"
ts=$(date '+%Y-%m-%d %H:%M:%S %z')
if ! curl -sfS -o /tmp/atom-morning-run.json -w '' \
  -X POST http://127.0.0.1:8787/api/run \
  -H 'content-type: application/json' \
  -d '{"source":"yzj-ai-advance"}'; then
  echo "[$ts] FAIL API down or /api/run error — start serve (launchd com.guoxinshan.atom.serve)" >> "$LOG"
  exit 1
fi
echo "[$ts] OK $(cat /tmp/atom-morning-run.json)" >> "$LOG"
