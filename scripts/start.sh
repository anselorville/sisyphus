#!/usr/bin/env bash
# One-shot dev launcher: stops any previously-running sidecar, backend AND
# frontend, then starts all three fresh. Safe to re-run repeatedly --
# cleanup is built in.
#
#   scripts/start.sh          # stop old instances, start sidecar + backend + frontend
#   scripts/start.sh stop     # just stop everything, start nothing
#
# Startup order (sidecar first, per the agent-runtime integration spec):
#   1. Check Node meets agent-runtime/package.json's engines.node requirement.
#   2. Build the sidecar if dist/ is missing (it's gitignored -- a fresh
#      checkout never has it) and start it, waiting for its port to come up.
#   3. Start the Python backend (which itself bridges to the sidecar over
#      loopback WebSocket -- see app/realtime/event_bridge.py).
#   4. Start the frontend.
# The sidecar is genuinely optional at runtime -- app/server.py and
# app/realtime/event_bridge.py both degrade gracefully to media-plane-only
# if it's unreachable -- so a sidecar build/start failure is reported as a
# warning here, never fatal: this script still brings up backend + frontend
# either way, and this script's exit code (unlike the summary printout)
# reflects only backend+frontend, matching its pre-sidecar contract.
#
# Sidecar:  node agent-runtime/dist/index.js  (port from .env AGENT_RUNTIME_PORT, default 8765)
# Backend:  uv run python -m app.server       (port from .env WEBRTC_PORT, default 7860)
# Frontend: npm --prefix client run dev       (Vite dev server, fixed port 1420
#           -- see client/vite.config.ts strictPort; the port is pinned so
#           this script's cleanup and the app's default server address stay
#           predictable. Pure web app: no Rust/Tauri anywhere in the run
#           path, the src-tauri directory is unused template scaffolding.)
#
# NOTE: this kills whatever holds port 1420, including Claude Code's own
# Preview server if one is running -- that's intentional: this script is for
# running the stack YOURSELF, outside Claude Code. (Claude Code sessions
# should keep using the Preview feature for the frontend instead.)
#
# Logs: /tmp/sisyphus-sidecar.log, /tmp/sisyphus-backend.log and /tmp/sisyphus-frontend.log

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SIDECAR_LOG="/tmp/sisyphus-sidecar.log"
BACKEND_LOG="/tmp/sisyphus-backend.log"
FRONTEND_LOG="/tmp/sisyphus-frontend.log"
FRONTEND_PORT=1420
SIDECAR_ENTRY="$REPO_ROOT/agent-runtime/dist/index.js"

# Resolve the backend port from .env's WEBRTC_PORT, falling back to 7860.
BACKEND_PORT=7860
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_PORT="$(grep -E '^WEBRTC_PORT=' "$REPO_ROOT/.env" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]' || true)"
  if [[ -n "$ENV_PORT" ]]; then
    BACKEND_PORT="$ENV_PORT"
  fi
fi

# Resolve the sidecar port from .env's AGENT_RUNTIME_PORT, falling back to
# 8765 -- matches both agent-runtime/src/config.ts's own default and
# app/config.py's AGENT_RUNTIME_URL default (ws://127.0.0.1:8765/events).
SIDECAR_PORT=8765
if [[ -f "$REPO_ROOT/.env" ]]; then
  ENV_SIDECAR_PORT="$(grep -E '^AGENT_RUNTIME_PORT=' "$REPO_ROOT/.env" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]' || true)"
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

# Poll briefly for a port instead of a long fixed sleep. Defined up front
# (not just before its first use) since both the sidecar and backend/
# frontend startup steps below need it.
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

echo "==> Stopping any existing services..."
kill_port "$SIDECAR_PORT" "sidecar"
kill_port "$BACKEND_PORT" "backend"
kill_port "$FRONTEND_PORT" "frontend"
# Belt-and-suspenders: also kill by invocation pattern, in case a previous
# run is hung without having bound its port (patterns are specific enough
# not to match unrelated tools like other apps' "app-server" processes).
pkill -f "agent-runtime/dist/index.js" 2>/dev/null || true
pkill -f "python -m app.server" 2>/dev/null || true
pkill -f "vite.*--prefix client" 2>/dev/null || true

if [[ "${1:-}" == "stop" ]]; then
  echo "==> Stopped. (start nothing: 'stop' given)"
  exit 0
fi

# --- Step 1: Node version check --------------------------------------------
# The sidecar's own package.json pins a minimum Node version; check it up
# front so a too-old Node produces one clear message here instead of an
# opaque crash from `tsc`/`node` later. Never fatal to the whole script --
# see the header comment for why.
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
    echo "==> WARNING: Node ${CURRENT_NODE_VERSION} does not satisfy agent-runtime's required engines.node (>=${REQUIRED_NODE_VERSION}) -- skipping the sidecar (backend/frontend still start)."
  fi
else
  echo "==> WARNING: node not found on PATH -- skipping the agent-runtime sidecar (backend/frontend still start)."
fi

# --- Step 2: build (if needed) and start the sidecar ------------------------
if [[ "$NODE_OK" -eq 1 && ! -f "$SIDECAR_ENTRY" ]]; then
  echo "==> Building agent-runtime sidecar (dist/ missing -- it's gitignored)..."
  if ! npm --prefix "$REPO_ROOT/agent-runtime" run build; then
    echo "==> WARNING: agent-runtime build failed -- skipping the sidecar (backend/frontend still start)."
    NODE_OK=0
  fi
fi

if [[ "$NODE_OK" -eq 1 && -f "$SIDECAR_ENTRY" ]]; then
  echo "==> Starting sidecar (node agent-runtime/dist/index.js) on port ${SIDECAR_PORT}..."
  # Source .env into this subshell first (set -a auto-exports every var it
  # defines) so cloud LLM provider keys (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY,
  # etc.) reach the sidecar's process env -- pi-ai (the sidecar's provider
  # auth layer, see @earendil-works/pi-ai) resolves those directly from
  # process.env, and unlike the Python backend (which loads .env itself via
  # python-dotenv), plain `node dist/index.js` never reads .env on its own.
  (
    cd "$REPO_ROOT"
    set -a
    [[ -f "$REPO_ROOT/.env" ]] && source "$REPO_ROOT/.env"
    set +a
    AGENT_RUNTIME_PORT="$SIDECAR_PORT" nohup node "$SIDECAR_ENTRY" >"$SIDECAR_LOG" 2>&1 </dev/null &
  ) >/dev/null 2>&1 </dev/null
fi

# --- Step 3: wait for the sidecar to be healthy (if we tried to start it) --
SIDECAR_OK=0
if [[ "$NODE_OK" -eq 1 && -f "$SIDECAR_ENTRY" ]]; then
  wait_for_port "$SIDECAR_PORT" && SIDECAR_OK=1 || true
  if [[ "$SIDECAR_OK" -ne 1 ]]; then
    echo "==> WARNING: sidecar did not bind port ${SIDECAR_PORT} within timeout -- check ${SIDECAR_LOG} (backend/frontend still start)."
  fi
fi

# --- Step 4: start the Python backend, then the frontend --------------------
echo "==> Starting backend (uv run python -m app.server) on port ${BACKEND_PORT}..."
# The outer redirections fully detach the launcher subshells (not just the
# nohup'd children) from this script's stdio -- without them, a caller that
# pipes our output (e.g. `scripts/start.sh | tee`) hangs at EOF because the
# lingering subshell still holds the pipe's write end.
(cd "$REPO_ROOT" && nohup uv run python -m app.server >"$BACKEND_LOG" 2>&1 </dev/null &) >/dev/null 2>&1 </dev/null

echo "==> Starting frontend (npm --prefix client run dev) on port ${FRONTEND_PORT}..."
(cd "$REPO_ROOT" && nohup npm --prefix client run dev >"$FRONTEND_LOG" 2>&1 </dev/null &) >/dev/null 2>&1 </dev/null

BACKEND_OK=0
FRONTEND_OK=0
wait_for_port "$BACKEND_PORT" && BACKEND_OK=1 || true
wait_for_port "$FRONTEND_PORT" && FRONTEND_OK=1 || true
SIDECAR_PID="$(lsof -ti ":${SIDECAR_PORT}" 2>/dev/null | head -n1 || true)"
BACKEND_PID="$(lsof -ti ":${BACKEND_PORT}" 2>/dev/null | head -n1 || true)"
FRONTEND_PID="$(lsof -ti ":${FRONTEND_PORT}" 2>/dev/null | head -n1 || true)"

echo ""
echo "==> Summary"
if [[ "$SIDECAR_OK" -eq 1 ]]; then
  echo "    Sidecar:  RUNNING  pid=${SIDECAR_PID}  ws://127.0.0.1:${SIDECAR_PORT}  log=${SIDECAR_LOG}"
else
  echo "    Sidecar:  NOT RUNNING (optional -- see ${SIDECAR_LOG} if this is unexpected)"
fi
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
# Exit status only reflects backend+frontend -- same contract as before this
# task's sidecar integration -- the sidecar degrades gracefully by design
# (see the header comment), so its absence alone must not fail this script.
[[ "$BACKEND_OK" -eq 1 && "$FRONTEND_OK" -eq 1 ]] || exit 1
echo ""
echo "    Open http://localhost:${FRONTEND_PORT} and press the power switch to connect."

# --- Open log-tail windows (macOS Terminal) ---
if command -v osascript &>/dev/null && [[ "$(uname)" == "Darwin" ]]; then
  echo ""
  echo "==> Opening log-tail windows..."
  if [[ "$SIDECAR_OK" -eq 1 ]]; then
    osascript -e "tell app \"Terminal\" to do script \"echo '=== Sidecar log: ${SIDECAR_LOG} ===' && tail -f ${SIDECAR_LOG}\"" &
  fi
  osascript -e "tell app \"Terminal\" to do script \"echo '=== Backend log: ${BACKEND_LOG} ===' && tail -f ${BACKEND_LOG}\"" &
  osascript -e "tell app \"Terminal\" to do script \"echo '=== Frontend log: ${FRONTEND_LOG} ===' && tail -f ${FRONTEND_LOG}\"" &
  echo "    Terminal windows opened for log monitoring."
fi
