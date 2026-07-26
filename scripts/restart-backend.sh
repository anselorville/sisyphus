#!/usr/bin/env bash
# Restarts the backend -- the Python server (uv run python -m app.server)
# AND the agent-runtime sidecar (node agent-runtime/dist/index.js) -- killing
# any already-running instances first -- safe to re-run repeatedly with no
# manual cleanup in between.
#
# Scope decision: the sidecar is included in "the backend" this script
# restarts, alongside the Python server. Reasoning: this script's own
# stated purpose is getting "the backend... back into a known-good state",
# and the Python server increasingly depends on the sidecar
# (app/realtime/event_bridge.py's SidecarEventBridge, GET
# /api/agent-runtime/status) -- leaving a stale/crashed sidecar running
# while only cycling the Python process would silently defeat that stated
# purpose, and a developer reaching for this script to fix "the backend"
# would reasonably expect the sidecar it now depends on to come back too.
# This is safe even where it turns out to be unnecessary: the sidecar
# degrades gracefully on its own (see app/server.py/app/realtime/
# event_bridge.py -- an unreachable or restarting sidecar never takes down
# WebRTC/STT/TTS), so restarting it here never risks the media pipeline.
# It is still very much NOT the frontend -- see below, unchanged from
# before this decision.
#
# Deliberately does NOT touch the frontend/port 1420: that port is owned
# exclusively by Claude Code's own preview-server tooling (preview_start /
# preview_stop), which refuses to run if anything else is already bound to
# it. Use the Preview feature for the frontend; use this script only to get
# the backend (Model Lab / Model Provider / the real translation pipeline /
# the agent-runtime sidecar) back into a known-good state without
# disturbing that.
#
# Usage: scripts/restart-backend.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_LOG="/tmp/sisyphus-backend.log"
SIDECAR_LOG="/tmp/sisyphus-sidecar.log"
SIDECAR_ENTRY="$REPO_ROOT/agent-runtime/dist/index.js"

# Resolve the backend port from .env's WEBRTC_PORT, falling back to 7860 if
# .env is missing or doesn't set it.
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
  local port="$1"
  local pids
  pids="$(lsof -ti ":${port}" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "    Killing process(es) on port ${port}: ${pids}"
    echo "$pids" | xargs -r kill -9 || true
  fi
}

# Poll briefly for a port to come up rather than a long fixed sleep. Defined
# up front since both the sidecar and backend startup steps below need it.
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

echo "==> Stopping any existing sidecar and backend..."
kill_port "$SIDECAR_PORT"
kill_port "$BACKEND_PORT"

# Belt-and-suspenders: also kill by invocation pattern, in case a previous
# run is hung without having bound its port yet, or bound a different port
# due to a misconfigured .env.
pkill -f "agent-runtime/dist/index.js" || true
pkill -f "python -m app.server" || true

# --- Node version check + build-if-needed + start the sidecar -------------
# Never fatal: if the sidecar can't come up for any reason, the Python
# backend still starts (see the header comment on why that's safe).
NODE_OK=0
if command -v node &>/dev/null; then
  REQUIRED_NODE_RANGE="$(node -p "require('$REPO_ROOT/agent-runtime/package.json').engines.node" 2>/dev/null || true)"
  REQUIRED_NODE_VERSION="${REQUIRED_NODE_RANGE#>=}"
  CURRENT_NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//' || true)"
  if [[ -z "$REQUIRED_NODE_VERSION" || -z "$CURRENT_NODE_VERSION" ]]; then
    echo "==> WARNING: could not verify Node version against agent-runtime/package.json engines.node -- attempting to start the sidecar anyway."
    NODE_OK=1
  elif [[ "$(printf '%s\n%s\n' "$REQUIRED_NODE_VERSION" "$CURRENT_NODE_VERSION" | sort -V | head -n1)" == "$REQUIRED_NODE_VERSION" ]]; then
    NODE_OK=1
  else
    echo "==> WARNING: Node ${CURRENT_NODE_VERSION} does not satisfy agent-runtime's required engines.node (>=${REQUIRED_NODE_VERSION}) -- skipping the sidecar (Python backend still restarts)."
  fi
else
  echo "==> WARNING: node not found on PATH -- skipping the agent-runtime sidecar (Python backend still restarts)."
fi

if [[ "$NODE_OK" -eq 1 && ! -f "$SIDECAR_ENTRY" ]]; then
  echo "==> Building agent-runtime sidecar (dist/ missing -- it's gitignored)..."
  if ! npm --prefix "$REPO_ROOT/agent-runtime" run build; then
    echo "==> WARNING: agent-runtime build failed -- skipping the sidecar (Python backend still restarts)."
    NODE_OK=0
  fi
fi

SIDECAR_OK=0
if [[ "$NODE_OK" -eq 1 && -f "$SIDECAR_ENTRY" ]]; then
  echo "==> Starting sidecar (node agent-runtime/dist/index.js) on port ${SIDECAR_PORT}..."
  (cd "$REPO_ROOT" && AGENT_RUNTIME_PORT="$SIDECAR_PORT" nohup node "$SIDECAR_ENTRY" >"$SIDECAR_LOG" 2>&1 &)
  wait_for_port "$SIDECAR_PORT" && SIDECAR_OK=1 || true
  if [[ "$SIDECAR_OK" -ne 1 ]]; then
    echo "==> WARNING: sidecar did not bind port ${SIDECAR_PORT} within timeout -- check ${SIDECAR_LOG} (Python backend still restarts)."
  fi
fi

echo "==> Starting backend (uv run python -m app.server) on port ${BACKEND_PORT}..."
(cd "$REPO_ROOT" && nohup uv run python -m app.server >"$BACKEND_LOG" 2>&1 &)

BACKEND_OK=0
wait_for_port "$BACKEND_PORT" && BACKEND_OK=1 || true
SIDECAR_PID="$(lsof -ti ":${SIDECAR_PORT}" 2>/dev/null | head -n1 || true)"
BACKEND_PID="$(lsof -ti ":${BACKEND_PORT}" 2>/dev/null | head -n1 || true)"

echo ""
echo "==> Summary"
if [[ "$SIDECAR_OK" -eq 1 ]]; then
  echo "    Sidecar: RUNNING  pid=${SIDECAR_PID}  port=${SIDECAR_PORT}  log=${SIDECAR_LOG}"
else
  echo "    Sidecar: NOT RUNNING (optional -- see ${SIDECAR_LOG} if this is unexpected)"
fi
if [[ "$BACKEND_OK" -eq 1 ]]; then
  echo "    Backend: RUNNING  pid=${BACKEND_PID}  port=${BACKEND_PORT}  log=${BACKEND_LOG}"
else
  echo "    Backend: FAILED to come up on port ${BACKEND_PORT} within timeout -- check ${BACKEND_LOG}"
  exit 1
fi
echo "    Frontend is NOT touched by this script -- use Claude Code's Preview feature for it."
