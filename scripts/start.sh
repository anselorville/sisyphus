#!/usr/bin/env bash
# One-shot dev launcher: stops any previously-running backend AND frontend,
# then starts both fresh. Safe to re-run repeatedly -- cleanup is built in.
#
#   scripts/start.sh          # stop old instances, start backend + frontend
#   scripts/start.sh stop     # just stop everything, start nothing
#
# Backend:  uv run python -m app.server   (port from .env WEBRTC_PORT, default 7860)
# Frontend: npm --prefix client run dev   (Vite dev server, fixed port 1420
#           -- see client/vite.config.ts strictPort; the port is pinned so
#           this script's cleanup and the app's default server address stay
#           predictable. Pure web app: no Rust/Tauri anywhere in the run
#           path, the src-tauri directory is unused template scaffolding.)
#
# NOTE: this kills whatever holds port 1420, including Claude Code's own
# Preview server if one is running -- that's intentional: this script is for
# running the stack YOURSELF, outside Claude Code. (Claude Code sessions
# should keep using the Preview feature + scripts/restart-backend.sh.)
#
# Logs: /tmp/sisyphus-backend.log and /tmp/sisyphus-frontend.log

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_LOG="/tmp/sisyphus-backend.log"
FRONTEND_LOG="/tmp/sisyphus-frontend.log"
FRONTEND_PORT=1420

# Resolve the backend port from .env's WEBRTC_PORT, falling back to 7860.
BACKEND_PORT=7860
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_PORT="$(grep -E '^WEBRTC_PORT=' "$REPO_ROOT/.env" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
  if [[ -n "$ENV_PORT" ]]; then
    BACKEND_PORT="$ENV_PORT"
  fi
fi

kill_port() {
  local port="$1" label="$2"
  local pids
  pids="$(lsof -ti ":${port}" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "    Killing ${label} on port ${port}: ${pids}"
    echo "$pids" | xargs -r kill -9 || true
  fi
}

echo "==> Stopping any existing services..."
kill_port "$BACKEND_PORT" "backend"
kill_port "$FRONTEND_PORT" "frontend"
# Belt-and-suspenders: also kill by invocation pattern, in case a previous
# run is hung without having bound its port (patterns are specific enough
# not to match unrelated tools like other apps' "app-server" processes).
pkill -f "python -m app.server" 2>/dev/null || true
pkill -f "vite.*--prefix client" 2>/dev/null || true

if [[ "${1:-}" == "stop" ]]; then
  echo "==> Stopped. (start nothing: 'stop' given)"
  exit 0
fi

echo "==> Starting backend (uv run python -m app.server) on port ${BACKEND_PORT}..."
# The outer redirections fully detach the launcher subshells (not just the
# nohup'd children) from this script's stdio -- without them, a caller that
# pipes our output (e.g. `scripts/start.sh | tee`) hangs at EOF because the
# lingering subshell still holds the pipe's write end.
(cd "$REPO_ROOT" && nohup uv run python -m app.server >"$BACKEND_LOG" 2>&1 </dev/null &) >/dev/null 2>&1 </dev/null

echo "==> Starting frontend (npm --prefix client run dev) on port ${FRONTEND_PORT}..."
(cd "$REPO_ROOT" && nohup npm --prefix client run dev >"$FRONTEND_LOG" 2>&1 </dev/null &) >/dev/null 2>&1 </dev/null

# Poll briefly for each port instead of a long fixed sleep.
wait_for_port() {
  local port="$1"
  local tries=0
  while (( tries < 30 )); do
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
  echo "    Backend:  RUNNING  pid=${BACKEND_PID}  http://localhost:${BACKEND_PORT}  log=${BACKEND_LOG}"
else
  echo "    Backend:  FAILED to bind port ${BACKEND_PORT} -- check ${BACKEND_LOG}"
fi
if [[ "$FRONTEND_OK" -eq 1 ]]; then
  echo "    Frontend: RUNNING  pid=${FRONTEND_PID}  http://localhost:${FRONTEND_PORT}  log=${FRONTEND_LOG}"
else
  echo "    Frontend: FAILED to bind port ${FRONTEND_PORT} -- check ${FRONTEND_LOG}"
fi
[[ "$BACKEND_OK" -eq 1 && "$FRONTEND_OK" -eq 1 ]] || exit 1
echo ""
echo "    Open http://localhost:${FRONTEND_PORT} and press the power switch to connect."
