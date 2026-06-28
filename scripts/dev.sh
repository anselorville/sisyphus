#!/usr/bin/env bash
# Starts the backend (uv run python -m app.server) and frontend (npm run dev,
# i.e. Vite) dev servers, killing any already-running instances first so this
# script is always a clean restart -- safe to re-run repeatedly with no
# manual cleanup in between.
#
# Usage: scripts/dev.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_LOG="/tmp/sisyphus-backend.log"
FRONTEND_LOG="/tmp/sisyphus-frontend.log"

# Resolve the backend port from .env's WEBRTC_PORT, falling back to 7860 if
# .env is missing or doesn't set it.
BACKEND_PORT=7860
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_PORT="$(grep -E '^WEBRTC_PORT=' "$REPO_ROOT/.env" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
  if [[ -n "$ENV_PORT" ]]; then
    BACKEND_PORT="$ENV_PORT"
  fi
fi

# Vite's dev port is hardcoded to 1420 by client/src-tauri/tauri.conf.json's
# "devUrl" -- do not change this independently of that file.
FRONTEND_PORT=1420

echo "==> Cleaning up any existing dev servers..."

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti ":${port}" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "    Killing process(es) on port ${port}: ${pids}"
    echo "$pids" | xargs -r kill -9 || true
  fi
}

kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

# Belt-and-suspenders: also kill by invocation pattern, in case a previous
# run is hung without having bound its port yet, or bound a different port
# due to a misconfigured .env.
pkill -f "python -m app.server" || true

echo "==> Starting backend (uv run python -m app.server) on port ${BACKEND_PORT}..."
(cd "$REPO_ROOT" && nohup uv run python -m app.server >"$BACKEND_LOG" 2>&1 &)

echo "==> Starting frontend (npm run dev) on port ${FRONTEND_PORT}..."
(cd "$REPO_ROOT/client" && nohup npm run dev >"$FRONTEND_LOG" 2>&1 &)

# Poll briefly for both ports to come up rather than a long fixed sleep.
wait_for_port() {
  local port="$1"
  local tries=0
  while (( tries < 20 )); do
    if lsof -ti ":${port}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
    tries=$((tries + 1))
  done
  return 1
}

BACKEND_OK=0
FRONTEND_OK=0
wait_for_port "$BACKEND_PORT" && BACKEND_OK=1 || true
wait_for_port "$FRONTEND_PORT" && FRONTEND_OK=1 || true

BACKEND_PID="$(lsof -ti ":${BACKEND_PORT}" 2>/dev/null | head -n1 || true)"
FRONTEND_PID="$(lsof -ti ":${FRONTEND_PORT}" 2>/dev/null | head -n1 || true)"

echo ""
echo "==> Summary"
if [[ "$BACKEND_OK" -eq 1 ]]; then
  echo "    Backend:  RUNNING  pid=${BACKEND_PID}  port=${BACKEND_PORT}  log=${BACKEND_LOG}"
else
  echo "    Backend:  FAILED to come up on port ${BACKEND_PORT} within timeout -- check ${BACKEND_LOG}"
fi
if [[ "$FRONTEND_OK" -eq 1 ]]; then
  echo "    Frontend: RUNNING  pid=${FRONTEND_PID}  port=${FRONTEND_PORT}  log=${FRONTEND_LOG}"
else
  echo "    Frontend: FAILED to come up on port ${FRONTEND_PORT} within timeout -- check ${FRONTEND_LOG}"
fi

if [[ "$BACKEND_OK" -eq 0 || "$FRONTEND_OK" -eq 0 ]]; then
  exit 1
fi
