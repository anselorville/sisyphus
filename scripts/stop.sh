#!/usr/bin/env bash
# Stop all sisyphus services: backend AND frontend.
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
kill_port "$BACKEND_PORT" "backend"
kill_port "$FRONTEND_PORT" "frontend"

# Belt-and-suspenders: also kill by invocation pattern.
pkill -f "python -m app.server" 2>/dev/null || true
pkill -f "vite.*--prefix client" 2>/dev/null || true

echo "==> All services stopped."
