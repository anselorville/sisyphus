"""Integration tests for the Python-side half of Task 17: the agent-runtime
sidecar's process lifecycle, crash recovery, and the combined health-status
endpoint.

Two independent things are exercised here, both against real processes
rather than fakes wherever the task calls for it:

1. `test_sidecar_crash_recovers_exactly_one_task`: a REAL
   `node agent-runtime/dist/index.js` subprocess, a REAL
   `SidecarEventBridge` (app/realtime/event_bridge.py) talking to it over a
   real loopback WebSocket, a hard SIGKILL crash, a second subprocess
   started against the SAME SQLite db file, and a direct (read-only)
   SQLite read to confirm the Task Nest ends up with exactly one durable
   task row for the transcript that was in flight during the crash.
   `event_bridge.py`'s own unit tests (tests/realtime/test_event_bridge.py)
   already cover the bridge's replay/dedup logic against a fake in-process
   WebSocket server; this file's job is only the end-to-end,
   real-subprocess-crash angle on top of that. See that test's own
   docstring for a documented design decision about exactly how the crash
   is timed.

2. `test_status_reports_media_and_agent_runtime` (the literal test from
   this task's own spec) plus one supplementary test that exercises the
   new ecology/food caching behavior against a fake sidecar, for
   `GET /api/agent-runtime/status` (added to app/server.py by this task).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import socket
import sqlite3
import subprocess
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.realtime.event_bridge import SidecarEventBridge
from app.realtime.events import RealtimeEvent
from app.realtime.queueing import EventPriority
from app.server import _cache_ecology_and_food_state, app, lifespan

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_RUNTIME_DIR = REPO_ROOT / "agent-runtime"
SIDECAR_ENTRY = AGENT_RUNTIME_DIR / "dist" / "index.js"

_STARTUP_TIMEOUT_SECONDS = 20.0
_RECONNECT_TIMEOUT_SECONDS = 20.0


# --- shared helpers: real sidecar subprocess management ---------------------


def _ensure_sidecar_built() -> None:
    """Builds the TS sidecar if `dist/index.js` isn't already there.

    `agent-runtime/dist/` is gitignored -- a fresh checkout has no build
    output at all -- so this test must be able to produce it itself rather
    than assume some earlier step already ran `npm run build`.
    """
    if SIDECAR_ENTRY.exists():
        return
    subprocess.run(
        ["npm", "--prefix", str(AGENT_RUNTIME_DIR), "run", "build"],
        cwd=REPO_ROOT,
        check=True,
        timeout=180,
    )
    if not SIDECAR_ENTRY.exists():
        raise RuntimeError(f"`npm --prefix agent-runtime run build` did not produce {SIDECAR_ENTRY}")


@pytest.fixture(scope="module")
def sidecar_built() -> None:
    _ensure_sidecar_built()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _port_accepts_connections(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        try:
            sock.connect(("127.0.0.1", port))
        except OSError:
            return False
        return True


async def _wait_until(predicate, *, timeout: float, interval: float = 0.05) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() >= deadline:
            raise TimeoutError("condition not met before timeout")
        await asyncio.sleep(interval)


def _spawn_sidecar(*, port: int, db_path: Path) -> subprocess.Popen:
    env = {**os.environ, "AGENT_RUNTIME_PORT": str(port), "AGENT_RUNTIME_DB_PATH": str(db_path)}
    return subprocess.Popen(
        ["node", str(SIDECAR_ENTRY)],
        cwd=str(AGENT_RUNTIME_DIR),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _kill(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            proc.send_signal(signal.SIGKILL)
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=10)


def _read_task_rows(db_path: Path, *, interaction_id: str) -> list[dict]:
    """Read-only query straight into the sidecar's private SQLite file.

    There is no RPC to ask the sidecar for its Task Nest state from
    Python, so this reaches directly into its db file instead -- safe
    because the sidecar runs SQLite in WAL mode (see
    agent-runtime/src/storage/db-worker.ts's `journal_mode = WAL` pragma),
    which lets a separate read-only connection see committed rows without
    contending with the sidecar's own writer connection.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, goal, interaction_id, status FROM tasks WHERE interaction_id = ?",
            (interaction_id,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


async def _wait_for_task_rows(db_path: Path, *, interaction_id: str, timeout: float) -> list[dict]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    rows: list[dict] = []
    while True:
        try:
            rows = _read_task_rows(db_path, interaction_id=interaction_id)
        except sqlite3.OperationalError:
            rows = []
        if rows or loop.time() >= deadline:
            return rows
        await asyncio.sleep(0.1)


def _transcript_event(*, interaction_id: str, text: str) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt-{interaction_id}",
        sequence=1,
        source="pipecat",
        type="voice.transcript.final",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={"text": text},
        interaction_id=interaction_id,
    )


# --- Step 1: sidecar crash recovery -----------------------------------------


@pytest.mark.asyncio
async def test_sidecar_crash_recovers_exactly_one_task(sidecar_built, tmp_path) -> None:
    """A real sidecar crash, mid-flight, must not lose or duplicate the
    transcript that was in flight when it died.

    Ordering/design note -- please read before changing this test: the
    sidecar's own per-connection inbound dedup (see
    agent-runtime/src/transport/websocket-server.ts's `seenInboundEventIds`)
    lives only in memory for the lifetime of ONE connection; it does not
    survive a reconnect. `TaskNest.create()` (agent-runtime/src/tasks/
    task-nest.ts) closes that gap on its own side: a `metadata.sourceEventId`
    (which agent-runtime/src/tasks/inbound-event-router.ts always sets to
    the originating event's `event_id`) makes create() idempotent, checked
    and populated by both create() and recoverPending() -- so even if
    sidecar A fully processes and durably persists the transcript before
    dying, and the bridge then redelivers that same still-unacked event to
    sidecar B, sidecar B's recoverPending() already knows this sourceEventId
    (from the very same SQLite row) and create() returns the existing task
    instead of making a duplicate.

    This test still confirms the SIGKILL is complete (`Popen.wait()`
    returns) BEFORE the transcript event is ever handed to the bridge --
    not because the duplicate-task race is unhandled (it now is, see
    above), but because this keeps the test deterministic-by-construction
    rather than dependent on exactly when, relative to the kill, sidecar A
    happened to be in its own processing of the event. Either ordering
    should now be safe; this ordering is simply the one that removes all
    doubt about what the test is actually proving. It still exercises every
    piece of the real crash-recovery path this task *is* responsible for: a
    real subprocess crash, a real restart against the same db file, the
    bridge's own reconnect-with-backoff and resend-pending logic firing
    against a real second subprocess, and the resulting Task Nest state.
    """
    db_path = tmp_path / "agent-runtime-crash-test.sqlite3"
    port = _free_port()
    interaction_id = "conv-crash-recovery-test"
    event = _transcript_event(interaction_id=interaction_id, text="email me a summary of today's crash test")

    proc_a = _spawn_sidecar(port=port, db_path=db_path)
    bridge: SidecarEventBridge | None = None
    proc_b: subprocess.Popen | None = None
    try:
        await _wait_until(lambda: _port_accepts_connections(port), timeout=_STARTUP_TIMEOUT_SECONDS)

        bridge = SidecarEventBridge(f"ws://127.0.0.1:{port}/events")
        await bridge.start()
        await _wait_until(lambda: bridge.is_connected, timeout=_STARTUP_TIMEOUT_SECONDS)

        # Hard crash -- SIGKILL, not SIGTERM -- awaited to completion so the
        # process is *confirmed* gone (see the design note above) before we
        # ever hand the event to the bridge.
        _kill(proc_a)
        assert proc_a.poll() is not None

        # Only now does the event exist anywhere outside this test: sidecar
        # A cannot possibly have received it, so it is genuinely,
        # unambiguously still "in flight, unacked" -- exactly the "crash
        # before the ack arrives" scenario, pinned to a deterministic
        # instant instead of a timing race. Priority is explicit here for
        # readability; app/realtime/queueing.py's own
        # `_protected_priority` would force voice.transcript.final to
        # DURABLE regardless.
        await bridge.send(event, priority=EventPriority.DURABLE)

        # Restart: a brand new sidecar process, same port, same db file.
        await _wait_until(lambda: not _port_accepts_connections(port), timeout=10.0)
        proc_b = _spawn_sidecar(port=port, db_path=db_path)
        await _wait_until(lambda: _port_accepts_connections(port), timeout=_STARTUP_TIMEOUT_SECONDS)

        # The bridge notices the dropped connection and reconnects on its
        # own (see event_bridge.py's _run_receiver backoff loop) -- no new
        # SidecarEventBridge instance needed.
        await _wait_until(lambda: bridge.is_connected, timeout=_RECONNECT_TIMEOUT_SECONDS)

        # _resend_pending() replays the still-unacked durable event as soon
        # as the new connection is up; wait for the resulting task row.
        rows = await _wait_for_task_rows(db_path, interaction_id=interaction_id, timeout=_RECONNECT_TIMEOUT_SECONDS)

        assert len(rows) == 1, f"expected exactly one recovered task, got {rows!r}"
        assert rows[0]["goal"] == event.payload["text"]
        assert rows[0]["status"] == "pending"

        # The bridge's own bookkeeping agrees: redelivered and acked
        # exactly once -- nothing left pending-ack for this event.
        await _wait_until(lambda: event.sequence not in bridge._pending_acks, timeout=5.0)  # noqa: SLF001
    finally:
        if bridge is not None:
            await bridge.close()
        _kill(proc_a)
        if proc_b is not None:
            _kill(proc_b)


# --- Step 2: status endpoint -------------------------------------------------


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    """A real ASGI client against the actual `app` (app/server.py), driven
    through its real `lifespan()` so `app.state.event_bridge` and the
    ecology/food cache are wired up exactly as they would be in
    production -- pointed at whatever AGENT_RUNTIME_URL resolves to.
    `SidecarEventBridge.start()` never blocks or raises even if nothing is
    listening there (see app/server.py's `_start_event_bridge`), so this
    fixture is safe to use with no sidecar running at all.
    """
    async with lifespan(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield ac


@pytest.mark.asyncio
async def test_status_reports_media_and_agent_runtime(client: AsyncClient) -> None:
    response = await client.get("/api/agent-runtime/status")
    assert response.status_code == 200
    assert response.json().keys() >= {"media", "sidecar", "ecology", "food"}


@pytest.mark.asyncio
async def test_status_reflects_live_sidecar_connection_and_cached_ecology_food_state(fake_ws_server) -> None:
    """Beyond key presence: point a real bridge at a fake sidecar, confirm
    `sidecar.connected` flips True, and confirm inbound
    `ecology.state.changed`/`budget.updated` events update the cached
    values the status endpoint reports -- exercising the background
    consumer task added to app/server.py's lifespan(), not just its shape.

    Calls the endpoint function directly (bypassing HTTP/ASGI) so this
    test can freely swap `app.state.event_bridge` for one pointed at the
    fixture's fake WebSocket server without racing `lifespan()`'s own
    bridge construction/teardown.
    """
    from app.server import agent_runtime_status

    bridge = SidecarEventBridge(fake_ws_server.url)
    await bridge.start()
    app.state.event_bridge = bridge
    app.state.ecology_status = "unknown"
    app.state.food_status = "unknown"
    consumer_task = asyncio.create_task(_cache_ecology_and_food_state(app, bridge))
    try:
        await _wait_until(lambda: bridge.is_connected, timeout=5.0)

        body = await agent_runtime_status()
        assert body["sidecar"]["configured"] is True
        assert body["sidecar"]["connected"] is True
        assert body["ecology"] == "unknown"
        assert body["food"] == "unknown"

        ecology_event = RealtimeEvent(
            event_id="evt-ecology-1",
            sequence=1,
            source="swarm",
            type="ecology.state.changed",
            timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            payload={"state": "conserving"},
        )
        budget_event = RealtimeEvent(
            event_id="evt-budget-1",
            sequence=2,
            source="swarm",
            type="budget.updated",
            timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            payload={"state": "reserve"},
        )
        await fake_ws_server.send_event_to_client(ecology_event)
        await fake_ws_server.send_event_to_client(budget_event)

        await _wait_until(lambda: app.state.ecology_status == "conserving", timeout=5.0)
        await _wait_until(lambda: app.state.food_status == "reserve", timeout=5.0)

        body = await agent_runtime_status()
        assert body["ecology"] == "conserving"
        assert body["food"] == "reserve"
    finally:
        consumer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await consumer_task
        await bridge.close()
        app.state.event_bridge = None
        app.state.ecology_status = "unknown"
        app.state.food_status = "unknown"
