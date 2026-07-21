#!/usr/bin/env bash
# Restarts ONLY the backend (uv run python -m app.server), killing any
# already-running instance first -- safe to re-run repeatedly with no
# manual cleanup in between.
#
# Deliberately does NOT touch the frontend/port 1420: that port is owned
# exclusively by Claude Code's own preview-server tooling (preview_start /
# preview_stop), which refuses to run if anything else is already bound to
# it. Use the Preview feature for the frontend; use this script only to get
# the backend (Model Lab / Model Provider / the real translation pipeline)
# back into a known-good state without disturbing that.
#
# Usage: scripts/restart-backend.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_LOG="/tmp/sisyphus-backend.log"

# Resolve the backend port from .env's WEBRTC_PORT, falling back to 7860 if
# .env is missing or doesn't set it.
BACKEND_PORT=7860
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_PORT="$(grep -E '^WEBRTC_PORT=' "$REPO_ROOT/.env" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
  if [[ -n "$ENV_PORT" ]]; then
    BACKEND_PORT="$ENV_PORT"
  fi
fi

echo "==> Stopping any existing backend..."

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

# Belt-and-suspenders: also kill by invocation pattern, in case a previous
# run is hung without having bound its port yet, or bound a different port
# due to a misconfigured .env.
pkill -f "python -m app.server" || true

echo "==> Starting backend (uv run python -m app.server) on port ${BACKEND_PORT}..."
(cd "$REPO_ROOT" && nohup uv run python -m app.server >"$BACKEND_LOG" 2>&1 &)

# Poll briefly for the port to come up rather than a long fixed sleep.
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
wait_for_port "$BACKEND_PORT" && BACKEND_OK=1 || true
BACKEND_PID="$(lsof -ti ":${BACKEND_PORT}" 2>/dev/null | head -n1 || true)"

echo ""
echo "==> Summary"
if [[ "$BACKEND_OK" -eq 1 ]]; then
  echo "    Backend: RUNNING  pid=${BACKEND_PID}  port=${BACKEND_PORT}  log=${BACKEND_LOG}"
else
  echo "    Backend: FAILED to come up on port ${BACKEND_PORT} within timeout -- check ${BACKEND_LOG}"
  exit 1
fi
echo "    Frontend is NOT touched by this script -- use Claude Code's Preview feature for it."
