#!/usr/bin/env bash
# Start the Discord bot (worker must already be running).
set -euo pipefail
cd "$(dirname "$0")"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and fill Discord credentials." >&2
  exit 1
fi

if ! curl -sf -H "Authorization: Bearer $(grep '^WORKER_API_TOKEN=' .env | cut -d= -f2-)" \
  http://127.0.0.1:8765/health >/dev/null 2>&1; then
  echo "Worker is not healthy on :8765. Start it first: ./start-worker.sh" >&2
  exit 1
fi

mkdir -p recordings
nohup node --env-file=.env dist/bot/src/index.js >> recordings/bot.log 2>&1 &
echo $! > recordings/bot.pid
echo "Bot started (pid $(cat recordings/bot.pid)). Log: recordings/bot.log"
