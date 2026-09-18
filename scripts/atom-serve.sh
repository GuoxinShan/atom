#!/bin/bash
set -euo pipefail
export PATH="/Users/kingdee/.grok/bin:/opt/homebrew/bin:/Users/kingdee/.local/bin:/usr/bin:/bin"
cd /Users/kingdee/dev/personal/atom
exec /opt/homebrew/bin/pnpm serve
