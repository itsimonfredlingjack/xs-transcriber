#!/usr/bin/env bash
# Start worker + Discord bot in the background.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p recordings

# Avoid double-start
if pgrep -f 'uvicorn worker.main:app' >/dev/null 2>&1; then
  echo "Worker already running."
else
  nohup ./start-worker.sh >> recordings/worker.log 2>&1 &
  echo $! > recordings/worker.pid
  echo "Worker started (pid $(cat recordings/worker.pid))."
  # Wait until health responds
  for _ in $(seq 1 20); do
    if curl -sf -H "Authorization: Bearer $(grep '^WORKER_API_TOKEN=' .env | cut -d= -f2-)" \
      http://127.0.0.1:8765/health >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

if pgrep -f 'dist/bot/src/index.js' >/dev/null 2>&1; then
  echo "Bot already running."
else
  ./start-bot.sh
fi

echo "Done. Status: ./status.sh"
