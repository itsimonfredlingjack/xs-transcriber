#!/usr/bin/env bash
# Start the GPU transcription worker with NVIDIA pip libraries on the path.
set -euo pipefail
cd "$(dirname "$0")"

VENV_SITE="/home/simon/whisper/venv/lib/python3.12/site-packages"
NV_LIBS=""
if [[ -d "$VENV_SITE/nvidia" ]]; then
  while IFS= read -r dir; do
    NV_LIBS+="${dir}:"
  done < <(find "$VENV_SITE/nvidia" -type d -name lib 2>/dev/null)
fi
export LD_LIBRARY_PATH="${NV_LIBS}${LD_LIBRARY_PATH:-}"

# Load .env into the process environment (uvicorn --env-file alone has been flaky).
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "Starting worker WHISPER_FINAL_MODEL=${WHISPER_FINAL_MODEL:-} WHISPER_FINAL_REVISION=${WHISPER_FINAL_REVISION:-} WHISPER_COMPUTE_TYPE=${WHISPER_COMPUTE_TYPE:-} LD_LIBRARY_PATH set"

exec /home/simon/whisper/venv/bin/python -m uvicorn worker.main:app \
  --host 127.0.0.1 --port 8765
