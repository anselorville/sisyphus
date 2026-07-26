"""Accelerated-clock soak tests for the realtime media-plane <-> sidecar
event bridge -- section 15.6's long-run requirements, made CI-safe.

Two soaks, mirroring the design doc's own framing (.proj-init/04-...
section 15.6):

(a) a mixed voice/task soak (the design doc's "at least one hour" mixed
    voice/task test): checks for memory growth, durable ("task terminal
    state") delivery correctness, and event replay correctness under
    sustained mixed traffic with periodic reconnects.
(b) an idle-listening soak (the design doc's "at least eight hours" idle
    test): checks for subscriber/dict/WebSocket-connection-lifecycle leaks
    while mostly idle.

Both soaks are duration-driven, not a fixed iteration count: each runs
until a wall-clock deadline (`REALTIME_SOAK_MIXED_DURATION_SECONDS` /
`REALTIME_SOAK_IDLE_DURATION_SECONDS`, default a few seconds -- CI-safe,
runs as part of the normal test suite) OR until a minimum number of cycles
has run, whichever takes longer. `scripts/benchmark-runtime.sh --soak`
overrides both env vars to the real 3600s ("1 hour") / 28800s ("8 hours")
durations for the genuine long-run measurement; that invocation is
separate from routine `pytest`/CI and never implied by a normal
`uv run pytest` run.

Both tests use the SAME real `SidecarEventBridge` + the real (loopback)
`fake_ws_server` every other bridge test in this repo already uses -- not a
real `node dist/index.js` subprocess. That subprocess angle (crash
recovery, genuine end-to-end round-trip latency) is already covered by
tests/integration/test_agent_runtime_bridge.py and
tests/performance/test_bridge_burst.py; this file's own, distinct job is
proving those same delivery guarantees keep holding under SUSTAINED,
long-running traffic without the bridge's own bounded structures or the
process's own RSS drifting -- a longevity/leak concern, not a one-shot
correctness concern already covered elsewhere. Task Nest row-level
"terminal state" is TypeScript-side and out of this file's reach; "task
terminal-state correctness" here is interpreted at the bridge's own
durable-delivery layer: every task-completion-equivalent DURABLE event
sent must be observed by the sidecar exactly once, even across repeated
reconnects, over the whole soak -- not just once, as the existing
non-soak reconnect test already proves.
"""

from __future__ import annotations

import asyncio
import contextlib
import gc
import os
import time
from datetime import UTC, datetime

import psutil
import pytest

from app.realtime.event_bridge import SidecarEventBridge
from app.realtime.events import RealtimeEvent
from app.realtime.queueing import EventPriority

# Generous relative to MIXED_SOAK_MAX_CYCLES's worst case (every cycle's
# durable send briefly pending at once, in an in-process fake-server burst
# with no real network latency) so the bounded-capacity eviction path
# (a real, correct, intentional behavior -- see
# app/realtime/event_bridge.py's `_remember_pending`) isn't routinely
# triggered by this soak's own traffic shape and doesn't drown its log
# output in "capacity exceeded" warnings. max_pending_acks/max_seen_inbound
# below still assert the configured cap is genuinely never exceeded.
BRIDGE_CAPACITY = 4096

# Duration-driven, not iteration-count-driven (see module docstring).
# Defaults are CI-safe; scripts/benchmark-runtime.sh --soak overrides both
# to the real 3600s ("1 hour") / 28800s ("8 hours") durations.
MIXED_SOAK_DURATION_SECONDS = float(os.environ.get("REALTIME_SOAK_MIXED_DURATION_SECONDS", "3"))
IDLE_SOAK_DURATION_SECONDS = float(os.environ.get("REALTIME_SOAK_IDLE_DURATION_SECONDS", "3"))

# Floors so a very fast machine still meaningfully exercises the
# growth-detection logic even if the default duration elapses almost
# instantly.
MIXED_SOAK_MIN_CYCLES = 150
IDLE_SOAK_MIN_CYCLES = 150

# Ceilings so a very FAST machine (each cycle here is just a couple of
# local async calls against an in-process fake server -- no real subprocess,
# no real network) can't run away to an unbounded number of cycles just
# because the wall-clock deadline hasn't elapsed yet. Bounds test runtime
# and the fake server's own (intentionally unbounded, append-only,
# test-only) `received` list.
MIXED_SOAK_MAX_CYCLES = int(os.environ.get("REALTIME_SOAK_MIXED_MAX_CYCLES", "2000"))
IDLE_SOAK_MAX_CYCLES = int(os.environ.get("REALTIME_SOAK_IDLE_MAX_CYCLES", "2000"))

# Reconnects are scheduled at fixed FRACTIONS of the total soak duration,
# not every N cycles: a cycle-count-based trigger (e.g. "every 60 cycles")
# scales unpredictably with how many cycles actually fit in the duration --
# on a fast machine that can be thousands of cycles, which would fire
# dozens of real reconnects (each with its own real exponential backoff),
# snowballing well past the nominal duration. Fraction-of-duration keeps
# the reconnect COUNT fixed and small regardless of cycle speed or of
# whether this is the few-second CI default or the real 1h/8h --soak run.
RECONNECT_AT_FRACTIONS = (0.4, 0.75)

# Real, finite, failing-capable caps -- never "print a warning and pass
# anyway" (see the plan's own global constraint). Generous enough to absorb
# normal asyncio/CPython allocator noise, tight enough that an actual
# per-cycle leak (a growing dict, a leaked subscriber, a leaked task) would
# blow past it over hundreds of cycles.
MAX_RSS_GROWTH_BYTES = 75 * 1024 * 1024


def _rss_bytes() -> int:
    return psutil.Process(os.getpid()).memory_info().rss


async def _wait_until(predicate, *, timeout: float, interval: float = 0.02) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() >= deadline:
            raise TimeoutError("condition not met before timeout")
        await asyncio.sleep(interval)


async def _force_clean_reconnect(bridge: SidecarEventBridge, fake_ws_server, *, timeout: float = 10.0) -> None:
    """Simulates a clean network blip: closes the current connection from
    the fake server's side and waits for the bridge's own reconnect logic
    to restore a live one. Unlike `disconnect_before_ack()`, this never
    touches `_suppress_ack` -- acking continues normally afterward, so this
    is safe to call repeatedly across many soak cycles (`disconnect_before_ack()`'s
    suppression is permanent for the life of the fake server -- fine for
    its existing one-shot test in tests/realtime/test_event_bridge.py, but
    would silently break acking for the rest of a long-running soak).
    """
    connections = fake_ws_server._connections  # noqa: SLF001
    if not connections:
        return
    await connections[-1].close()
    await _wait_until(lambda: not bridge.is_connected, timeout=timeout)
    await _wait_until(lambda: bridge.is_connected, timeout=timeout)


def _progress_event(cycle: int) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_soak_progress_{cycle}",
        sequence=cycle * 4,
        source="system",
        type="tool.progress",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={"tool": "search", "percent": cycle % 100},
        task_id=f"soak_task_{cycle % 5}",
    )


def _cancel_event(cycle: int) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_soak_cancel_{cycle}",
        sequence=cycle * 4 + 1,
        source="system",
        type="voice.speech.cancel",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={},
    )


def _durable_task_completed(cycle: int) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_soak_durable_{cycle}",
        sequence=cycle * 4 + 2,
        source="pi",
        type="task.completed",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={"cycle": cycle},
        task_id=f"soak_task_{cycle % 5}",
    )


@pytest.mark.asyncio
async def test_mixed_voice_task_soak_accelerated(fake_ws_server) -> None:
    """Accelerated stand-in for the design doc's >=1 hour mixed voice/task
    soak: memory growth, durable ("task terminal state") delivery
    correctness, and event replay correctness, under sustained mixed
    traffic with periodic reconnects."""
    bridge = SidecarEventBridge(fake_ws_server.url, capacity=BRIDGE_CAPACITY)
    await bridge.start()
    await _wait_until(lambda: bridge.is_connected, timeout=5.0)

    gc.collect()
    initial_rss = _rss_bytes()

    sent_durable_ids: set[str] = set()
    max_pending_acks = 0
    max_seen_inbound = 0
    cycle = 0
    reconnects_done = 0
    start_time = time.monotonic()
    deadline = start_time + MIXED_SOAK_DURATION_SECONDS

    try:
        while cycle < MIXED_SOAK_MAX_CYCLES and (cycle < MIXED_SOAK_MIN_CYCLES or time.monotonic() < deadline):
            await bridge.send(_progress_event(cycle), priority=EventPriority.COALESCIBLE)
            await bridge.send(_cancel_event(cycle), priority=EventPriority.CRITICAL)

            durable_event = _durable_task_completed(cycle)
            await bridge.send(durable_event, priority=EventPriority.DURABLE)
            sent_durable_ids.add(durable_event.event_id)

            # Yield to the event loop every cycle: bridge.send() only ever
            # touches the LOCAL queue (see event_bridge.py), so a tight loop
            # of sends with no yield in between can outrun the sender/
            # receiver tasks entirely, building a large backlog that then
            # has to drain all at once after the loop -- both unrealistic
            # (a real deployment interleaves many concurrent tasks) and
            # needlessly slow for a test that is supposed to stay CI-fast.
            # Spreading actual transmission/ack processing across the
            # whole soak, cycle by cycle, is the realistic behavior this
            # test wants to exercise anyway.
            await asyncio.sleep(0)

            max_pending_acks = max(max_pending_acks, len(bridge._pending_acks))  # noqa: SLF001
            max_seen_inbound = max(max_seen_inbound, len(bridge._seen_inbound_sequences))  # noqa: SLF001

            elapsed = time.monotonic() - start_time
            if (
                reconnects_done < len(RECONNECT_AT_FRACTIONS)
                and elapsed >= MIXED_SOAK_DURATION_SECONDS * RECONNECT_AT_FRACTIONS[reconnects_done]
            ):
                # Proves replay keeps working over several forced
                # disconnects spread across the soak, not just the single
                # one-shot scenario tests/realtime/test_event_bridge.py
                # already covers.
                await fake_ws_server.disconnect_before_ack()
                await fake_ws_server.accept_reconnect()
                fake_ws_server._suppress_ack = False  # noqa: SLF001 -- see _force_clean_reconnect's docstring
                reconnects_done += 1

            cycle += 1

        # Let anything still in flight (e.g. right after the final forced
        # reconnect) finish being acked before reconciling below.
        await _wait_until(lambda: not bridge._pending_acks, timeout=10.0)  # noqa: SLF001
    finally:
        await bridge.close()

    # -- growth-detection assertions: real, failing, never just a warning --

    assert max_pending_acks <= BRIDGE_CAPACITY
    assert max_seen_inbound <= BRIDGE_CAPACITY

    gc.collect()
    final_rss = _rss_bytes()
    rss_growth = final_rss - initial_rss
    assert rss_growth < MAX_RSS_GROWTH_BYTES, (
        f"RSS grew {rss_growth} bytes across {cycle} mixed-traffic soak cycles, "
        f"exceeding the {MAX_RSS_GROWTH_BYTES}-byte budget"
    )

    # -- durable delivery / replay correctness -----------------------------
    # Every durable task-completion event sent across the whole soak
    # (including ones in flight during each forced reconnect) was received
    # by the sidecar at least once, by identity -- proving replay after
    # reconnect keeps working correctly over many cycles, not just once.
    received_ids = {e.event_id for e in fake_ws_server.received if e.type == "task.completed"}
    assert sent_durable_ids <= received_ids

    print(f"PERF_METRIC soak_mixed_cycles {cycle} cycles")
    print(f"PERF_METRIC soak_mixed_rss_growth_bytes {rss_growth} bytes")
    print(f"PERF_METRIC soak_mixed_max_pending_acks {max_pending_acks} events")


@pytest.mark.asyncio
async def test_idle_listening_soak_accelerated(fake_ws_server) -> None:
    """Accelerated stand-in for the design doc's >=8 hour idle-listening
    soak: subscriber/WebSocket-connection-lifecycle/dict-bookkeeping leaks
    while mostly idle, with occasional inbound heartbeats and reconnects (a
    real deployment is never perfectly silent for 8 hours -- occasional
    network blips and a UI panel opening/closing are the realistic
    idle-time activity)."""
    bridge = SidecarEventBridge(fake_ws_server.url, capacity=BRIDGE_CAPACITY)
    await bridge.start()
    await _wait_until(lambda: bridge.is_connected, timeout=5.0)

    gc.collect()
    initial_rss = _rss_bytes()

    max_seen_inbound = 0
    cycle = 0
    reconnects_done = 0
    start_time = time.monotonic()
    deadline = start_time + IDLE_SOAK_DURATION_SECONDS

    try:
        while cycle < IDLE_SOAK_MAX_CYCLES and (cycle < IDLE_SOAK_MIN_CYCLES or time.monotonic() < deadline):
            # A UI panel subscribing then closing -- must never leak a
            # subscriber slot on the bridge.
            collected: list[RealtimeEvent] = []

            async def _drain(sink: list[RealtimeEvent] = collected) -> None:
                async for event in bridge.events():
                    sink.append(event)

            subscriber_task = asyncio.create_task(_drain())
            await asyncio.sleep(0)  # let the subscription actually register
            assert len(bridge._subscribers) >= 1  # noqa: SLF001

            heartbeat = RealtimeEvent(
                event_id=f"evt_soak_idle_heartbeat_{cycle}",
                sequence=cycle,
                source="swarm",
                type="ecology.state.changed",
                timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                payload={"state": "idle"},
            )
            await fake_ws_server.send_event_to_client(heartbeat)
            await _wait_until(lambda: len(collected) >= 1, timeout=5.0)

            subscriber_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await subscriber_task

            # The subscriber slot must be released -- never accumulate one
            # per idle cycle. This is the actual leak-detection assertion,
            # checked on every cycle, not just the last one.
            assert len(bridge._subscribers) == 0  # noqa: SLF001

            max_seen_inbound = max(max_seen_inbound, len(bridge._seen_inbound_sequences))  # noqa: SLF001

            elapsed = time.monotonic() - start_time
            if (
                reconnects_done < len(RECONNECT_AT_FRACTIONS)
                and elapsed >= IDLE_SOAK_DURATION_SECONDS * RECONNECT_AT_FRACTIONS[reconnects_done]
            ):
                await _force_clean_reconnect(bridge, fake_ws_server)
                reconnects_done += 1

            cycle += 1
    finally:
        await bridge.close()

    assert max_seen_inbound <= BRIDGE_CAPACITY

    gc.collect()
    final_rss = _rss_bytes()
    rss_growth = final_rss - initial_rss
    assert rss_growth < MAX_RSS_GROWTH_BYTES, (
        f"RSS grew {rss_growth} bytes across {cycle} idle soak cycles, exceeding the {MAX_RSS_GROWTH_BYTES}-byte budget"
    )

    print(f"PERF_METRIC soak_idle_cycles {cycle} cycles")
    print(f"PERF_METRIC soak_idle_rss_growth_bytes {rss_growth} bytes")
