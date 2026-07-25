#!/usr/bin/env bash
# Stop all sisyphus services: the agent-runtime sidecar, backend AND frontend.
# Safe to run repeatedly -- cleanup is idempotent.
#
# Usage: scripts/stop.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FRONTEND_PORT=1420

# Resolve the backend port from .env's WEBRTC_PORT, falling back to 7860.
BACKEND_PORT=7860
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_PORT="$(grep -E '^WEBRTC_PORT=' "$REPO_ROOT/.env" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
  if [[ -n "$ENV_PORT" ]]; then
    BACKEND_PORT="$ENV_PORT"
  fi
fi

# Resolve the sidecar port from .env's AGENT_RUNTIME_PORT, falling back to
# 8765 -- matches both agent-runtime/src/config.ts's own default and
# app/config.py's AGENT_RUNTIME_URL default (ws://127.0.0.1:8765/events).
SIDECAR_PORT=8765
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_SIDECAR_PORT="$(grep -E '^AGENT_RUNTIME_PORT=' "$REPO_ROOT/.env" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
  if [[ -n "$ENV_SIDECAR_PORT" ]]; then
    SIDECAR_PORT="$ENV_SIDECAR_PORT"
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

echo "==> Stopping sisyphus services..."
# Stop order: backend and frontend first (the transports/consumers), then
# the sidecar last -- mirrors the reverse of start.sh's sidecar-first
# startup order. There's no coordination possible from a shell script
# beyond ordering these kill commands; a running sidecar's own graceful
# SIGTERM handling (see agent-runtime/src/index.ts's main()) already does
# the right thing internally if it's sent one instead of SIGKILL, but
# kill_port here uses -9 for the same immediate, no-questions-asked cleanup
# this script has always done for backend/frontend.
kill_port "$BACKEND_PORT" "backend"
kill_port "$FRONTEND_PORT" "frontend"
kill_port "$SIDECAR_PORT" "sidecar"

# Belt-and-suspenders: also kill by invocation pattern.
pkill -f "python -m app.server" 2>/dev/null || true
pkill -f "vite.*--prefix client" 2>/dev/null || true
pkill -f "agent-runtime/dist/index.js" 2>/dev/null || true

echo "==> All services stopped."
