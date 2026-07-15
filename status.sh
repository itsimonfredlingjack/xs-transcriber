#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Processes ==="
pgrep -af 'uvicorn worker.main:app' || echo "worker: down"
pgrep -af 'dist/bot/src/index.js' || echo "bot: down"

echo
echo "=== Worker health ==="
if [[ -f .env ]]; then
  TOKEN=$(grep '^WORKER_API_TOKEN=' .env | cut -d= -f2-)
  curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/health 2>/dev/null \
    || echo "worker not reachable on :8765"
  echo
else
  echo "no .env"
fi

echo
echo "=== GPU ==="
nvidia-smi --query-gpu=memory.used,memory.free --format=csv 2>/dev/null || true
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv 2>/dev/null || true

echo
echo "=== llama-server (optional) ==="
docker ps -a --filter name=llama-server --format '{{.Names}}: {{.Status}}' 2>/dev/null || true
