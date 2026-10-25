#!/usr/bin/env bash
# Restart only the Python backend (the media plane), leaving the sidecar and
# frontend running. Used by the Device Steward's `service_action` tool and
# handy by hand.
#
#   scripts/restart-backend.sh
#
# The backend's port comes from .env's WEBRTC_PORT (default 7860); its log is
# /tmp/sisyphus-backend.log. Any open voice connection drops while it restarts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_LOG="/tmp/sisyphus-backend.log"
BACKEND_PORT=7860
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_PORT="$(grep -E '^WEBRTC_PORT=' "$REPO_ROOT/.env" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]' || true)"
  [[ -n "$ENV_PORT" ]] && BACKEND_PORT="$ENV_PORT"
fi

wait_for_port() { # wait_for_port <port> <up|down>
  local tries=0
  while (( tries < 60 )); do
    if lsof -ti ":$1" >/dev/null 2>&1; then [[ "$2" == up ]] && return 0; else [[ "$2" == down ]] && return 0; fi
    sleep 0.5
    tries=$((tries + 1))
  done
  return 1
}

PIDS="$(lsof -ti ":${BACKEND_PORT}" 2>/dev/null || true)"
if [[ -n "$PIDS" ]]; then
  echo "==> Stopping backend on port ${BACKEND_PORT}: ${PIDS}"
  echo "$PIDS" | xargs kill 2>/dev/null || true
  wait_for_port "$BACKEND_PORT" down || { echo "$PIDS" | xargs kill -9 2>/dev/null || true; wait_for_port "$BACKEND_PORT" down || true; }
fi

echo "==> Starting backend (uv run python -m app.server)..."
nohup uv run python -m app.server >"$BACKEND_LOG" 2>&1 </dev/null &
if wait_for_port "$BACKEND_PORT" up; then
  echo "==> Backend RUNNING on port ${BACKEND_PORT}  log=${BACKEND_LOG}"
else
  echo "==> Backend FAILED to bind port ${BACKEND_PORT} -- see ${BACKEND_LOG}" >&2
  exit 1
fi
