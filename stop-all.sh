#!/usr/bin/env bash
# Stop Discord bot + GPU worker. Does not touch llama-server.
set -euo pipefail
cd "$(dirname "$0")"

stop_pattern() {
  local label=$1
  local pattern=$2
  local pids
  pids=$(pgrep -f "$pattern" || true)
  if [[ -z "$pids" ]]; then
    echo "$label: not running"
    return
  fi
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  # shellcheck disable=SC2086
  pids=$(pgrep -f "$pattern" || true)
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  echo "$label: stopped"
}

stop_pattern "Bot" "dist/bot/src/index.js"
stop_pattern "Worker" "uvicorn worker.main:app"

rm -f recordings/bot.pid recordings/worker.pid 2>/dev/null || true
echo "Transcriber stopped. (llama-server is separate: docker stop/start llama-server)"
