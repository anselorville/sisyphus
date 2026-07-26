"""End-to-end burst-load test against a REAL agent-runtime sidecar subprocess.

`tests/performance/test_event_bridge_load.py` already covers this same
1,000-progress/20-cancel burst scenario, but -- per its own docstring -- it
measures only `SidecarEventBridge.send()`'s LOCAL enqueue cost against a fake
in-process WebSocket server; it explicitly does not measure real
network/subprocess round-trip time. This file is additive, not a copy: it is
the first test to measure a cancel event's true end-to-end latency, against a
real `node agent-runtime/dist/index.js` subprocess, spawned and driven the
same way `tests/integration/test_agent_runtime_bridge.py` does (building the
sidecar if `dist/index.js` is missing, since `agent-runtime/dist/` is
gitignored; spawning with `AGENT_RUNTIME_PORT`/`AGENT_RUNTIME_DB_PATH` env
vars). Cancel p95 here is genuinely end to end: local enqueue + real loopback
network hop out + real subprocess processing + real network hop back +
receiver dispatch.

Two things have no public SidecarEventBridge API to observe, and are added
here as test-only instrumentation -- monkeypatching *instance* methods on the
one `bridge` this test constructs, never touching app/realtime/event_bridge.py
itself:

1. Ack round-trip timing for CRITICAL-priority sends. `_remember_pending`
   (event_bridge.py's `_run_sender`) is only ever called `if priority is
   EventPriority.DURABLE`, so a CRITICAL event's ack arrives and is silently
   discarded (`_pending_acks.pop(sequence, None)` on a key that was never
   inserted) -- there is nothing to await. `_handle_wire_message` is wrapped
   to record the wall-clock moment each ack frame's raw bytes physically
   arrive, keyed by sequence, before delegating to the real handler
   unchanged.
2. A count of actual wire transmissions for `tool.progress` events, to prove
   coalescing reduced 1,000 raw `send()` calls to meaningfully fewer real
   transmissions. `_transmit` is wrapped the same non-invasive way: count,
   then delegate.

Both wrappers only ever observe behavior the bridge already exhibits -- they
never change what gets sent, dropped, coalesced, or when.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import socket
import sqlite3
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

import msgspec
import pytest

from app.realtime.event_bridge import SidecarEventBridge
from app.realtime.events import RealtimeEvent
from app.realtime.performance import percentile_ms
from app.realtime.queueing import EventPriority

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_RUNTIME_DIR = REPO_ROOT / "agent-runtime"
SIDECAR_ENTRY = AGENT_RUNTIME_DIR / "dist" / "index.js"

_STARTUP_TIMEOUT_SECONDS = 20.0
_RECONCILE_TIMEOUT_SECONDS = 15.0

BURST_PROGRESS_EVENTS = 1_000
BURST_CANCEL_EVENTS = 20
BURST_DURABLE_EVENTS = 20
BRIDGE_CAPACITY = 1024

# Distinct (task_id, tool) coalescing groups the 1,000 progress events cycle
# through -- app/realtime/queueing.py's BoundedEventQueue coalesces
# `tool.progress` events sharing the same task_id *and* payload["tool"], so
# cycling through a small number of groups (rather than test_event_bridge_load.py's
# one-unique-task_id-per-event, which never coalesces at all) gives repeated
# same-group sends real coalescing opportunities to collapse into the local
# queue's single pending slot before the sender drains them.
PROGRESS_COALESCE_SLOTS = 10

# End-to-end (real subprocess round trip) cancel-ack latency budget -- section
# 15.5's "本机事件桥单向排队与处理 p95 < 20ms" budget, this time measured
# genuinely end to end (see module docstring) rather than local-enqueue-only
# (see test_event_bridge_load.py's CRITICAL_SEND_LOCAL_BUDGET_MS).
CRITICAL_ACK_END_TO_END_BUDGET_MS = 20.0


# --- real sidecar subprocess management -------------------------------------
#
# Mirrors tests/integration/test_agent_runtime_bridge.py's own helpers
# (duplicated rather than imported: that is a sibling test module, not a
# shared library, and both files need only a handful of small functions).


def _ensure_sidecar_built() -> None:
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


def _read_task_rows(db_path: Path, *, interaction_ids: set[str]) -> list[dict]:
    """Read-only query straight into the sidecar's private SQLite file.

    Safe because the sidecar runs SQLite in WAL mode (see
    agent-runtime/src/storage/db-worker.ts's `journal_mode = WAL` pragma),
    which lets a separate read-only connection see committed rows without
    contending with the sidecar's own writer connection -- same pattern
    tests/integration/test_agent_runtime_bridge.py already established.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        conn.row_factory = sqlite3.Row
        placeholders = ",".join("?" for _ in interaction_ids)
        rows = conn.execute(
            f"SELECT id, interaction_id FROM tasks WHERE interaction_id IN ({placeholders})",  # noqa: S608
            tuple(interaction_ids),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


async def _wait_for_durable_rows(db_path: Path, *, interaction_ids: set[str], timeout: float) -> list[dict]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    rows: list[dict] = []
    while True:
        try:
            rows = _read_task_rows(db_path, interaction_ids=interaction_ids)
        except sqlite3.OperationalError:
            rows = []
        if len({row["interaction_id"] for row in rows}) == len(interaction_ids) or loop.time() >= deadline:
            return rows
        await asyncio.sleep(0.1)


# --- event construction ------------------------------------------------------


def _progress_event(index: int) -> RealtimeEvent:
    slot = index % PROGRESS_COALESCE_SLOTS
    return RealtimeEvent(
        event_id=f"evt_progress_{index}",
        sequence=index,
        source="system",
        type="tool.progress",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={"tool": "search", "percent": index % 100},
        task_id=f"burst_task_{slot}",
    )


def _cancel_event(cancel_index: int) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_cancel_{cancel_index}",
        sequence=BURST_PROGRESS_EVENTS + cancel_index,
        source="system",
        type="voice.speech.cancel",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={},
    )


def _durable_final_transcript(durable_index: int, *, interaction_id: str) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_final_{durable_index}",
        sequence=BURST_PROGRESS_EVENTS + BURST_CANCEL_EVENTS + durable_index,
        source="pipecat",
        type="voice.transcript.final",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={"text": f"durable burst marker {durable_index}"},
        interaction_id=interaction_id,
    )


@pytest.mark.asyncio
async def test_burst_load_against_real_sidecar_subprocess(sidecar_built, tmp_path) -> None:
    db_path = tmp_path / "bridge-burst.sqlite3"
    port = _free_port()
    proc = _spawn_sidecar(port=port, db_path=db_path)
    bridge: SidecarEventBridge | None = None

    try:
        await _wait_until(lambda: _port_accepts_connections(port), timeout=_STARTUP_TIMEOUT_SECONDS)

        bridge = SidecarEventBridge(f"ws://127.0.0.1:{port}/events", capacity=BRIDGE_CAPACITY)

        # --- test-only instrumentation (see module docstring) ---
        ack_arrival_ns: dict[int, int] = {}
        original_handle_wire_message = bridge._handle_wire_message  # noqa: SLF001

        async def _instrumented_handle_wire_message(connection, raw):
            try:
                decoded = msgspec.json.decode(raw)
            except msgspec.DecodeError:
                decoded = None
            if isinstance(decoded, dict) and decoded.get("kind") == "ack":
                sequence = decoded.get("sequence")
                if isinstance(sequence, int):
                    ack_arrival_ns[sequence] = time.perf_counter_ns()
            return await original_handle_wire_message(connection, raw)

        bridge._handle_wire_message = _instrumented_handle_wire_message  # noqa: SLF001

        transmitted_progress_count = 0
        original_transmit = bridge._transmit  # noqa: SLF001

        async def _counting_transmit(connection, event):
            nonlocal transmitted_progress_count
            if event.type == "tool.progress":
                transmitted_progress_count += 1
            return await original_transmit(connection, event)

        bridge._transmit = _counting_transmit  # noqa: SLF001

        await bridge.start()
        await _wait_until(lambda: bridge.is_connected, timeout=_STARTUP_TIMEOUT_SECONDS)

        cancel_send_started_ns: dict[int, int] = {}
        durable_interaction_ids: set[str] = set()
        max_depth = 0
        cancels_sent = 0
        durables_sent = 0

        cancel_stride = BURST_PROGRESS_EVENTS // BURST_CANCEL_EVENTS
        durable_stride = BURST_PROGRESS_EVENTS // BURST_DURABLE_EVENTS

        for index in range(BURST_PROGRESS_EVENTS):
            await bridge.send(_progress_event(index), priority=EventPriority.COALESCIBLE)
            max_depth = max(max_depth, bridge.queue_depth)

            if index % cancel_stride == 0 and cancels_sent < BURST_CANCEL_EVENTS:
                event = _cancel_event(cancels_sent)
                start_ns = time.perf_counter_ns()
                await bridge.send(event, priority=EventPriority.CRITICAL)
                cancel_send_started_ns[event.sequence] = start_ns
                cancels_sent += 1
                max_depth = max(max_depth, bridge.queue_depth)

            if index % durable_stride == 0 and durables_sent < BURST_DURABLE_EVENTS:
                interaction_id = f"burst-durable-{durables_sent}"
                event = _durable_final_transcript(durables_sent, interaction_id=interaction_id)
                await bridge.send(event, priority=EventPriority.DURABLE)
                durable_interaction_ids.add(interaction_id)
                durables_sent += 1
                max_depth = max(max_depth, bridge.queue_depth)

        while cancels_sent < BURST_CANCEL_EVENTS:
            event = _cancel_event(cancels_sent)
            start_ns = time.perf_counter_ns()
            await bridge.send(event, priority=EventPriority.CRITICAL)
            cancel_send_started_ns[event.sequence] = start_ns
            cancels_sent += 1
            max_depth = max(max_depth, bridge.queue_depth)

        while durables_sent < BURST_DURABLE_EVENTS:
            interaction_id = f"burst-durable-{durables_sent}"
            event = _durable_final_transcript(durables_sent, interaction_id=interaction_id)
            await bridge.send(event, priority=EventPriority.DURABLE)
            durable_interaction_ids.add(interaction_id)
            durables_sent += 1
            max_depth = max(max_depth, bridge.queue_depth)

        assert len(cancel_send_started_ns) == BURST_CANCEL_EVENTS

        # Every cancel's ack must genuinely arrive back over the real socket
        # from the real subprocess, and every durable send must be acked
        # (no longer pending) before we can reconcile anything below.
        await _wait_until(
            lambda: all(seq in ack_arrival_ns for seq in cancel_send_started_ns),
            timeout=_RECONCILE_TIMEOUT_SECONDS,
        )
        await _wait_until(lambda: not bridge._pending_acks, timeout=_RECONCILE_TIMEOUT_SECONDS)  # noqa: SLF001

        rows = await _wait_for_durable_rows(
            db_path, interaction_ids=durable_interaction_ids, timeout=_RECONCILE_TIMEOUT_SECONDS
        )
    finally:
        if bridge is not None:
            await bridge.close()
        _kill(proc)

    # --- assertions --------------------------------------------------------

    ack_latencies_ns = [ack_arrival_ns[seq] - started_ns for seq, started_ns in cancel_send_started_ns.items()]
    p95_ms = percentile_ms(ack_latencies_ns, 95)
    assert p95_ms < CRITICAL_ACK_END_TO_END_BUDGET_MS, (
        f"end-to-end cancel ack p95 was {p95_ms:.3f}ms, budget is {CRITICAL_ACK_END_TO_END_BUDGET_MS}ms"
    )

    assert max_depth <= BRIDGE_CAPACITY

    # Coalescing genuinely reduced wire traffic: far fewer real transmissions
    # than the 1,000 raw send() calls that were made.
    assert transmitted_progress_count < BURST_PROGRESS_EVENTS, (
        f"expected tool.progress coalescing to reduce wire transmissions below "
        f"{BURST_PROGRESS_EVENTS}, but {transmitted_progress_count} were actually sent"
    )

    # Durable events are never lost: every distinct interaction_id sent ends
    # up as exactly one durable Task Nest row, reconciled against real
    # SQLite written by the real subprocess.
    reconciled_ids = {row["interaction_id"] for row in rows}
    assert reconciled_ids == durable_interaction_ids

    print(f"PERF_METRIC bridge_burst_cancel_p50_ms {percentile_ms(ack_latencies_ns, 50):.3f} ms")
    print(f"PERF_METRIC bridge_burst_cancel_p95_ms {p95_ms:.3f} ms")
    print(f"PERF_METRIC bridge_burst_cancel_p99_ms {percentile_ms(ack_latencies_ns, 99):.3f} ms")
    print(f"PERF_METRIC bridge_burst_max_queue_depth {max_depth} events")
    print(f"PERF_METRIC bridge_burst_progress_wire_transmissions {transmitted_progress_count} events")
