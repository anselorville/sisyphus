"""Burst-load test for SidecarEventBridge's local queueing behavior.

Measures only the in-process cost of SidecarEventBridge.send() enqueuing an
event onto its local BoundedEventQueue -- NOT network round-trip time to the
sidecar. A live local fake server is still used underneath so the queue
actively drains under realistic backpressure, but the asserted budget covers
local queueing overhead only, mirroring the local-vs-end-to-end split
app/realtime/performance.py documents for barge-in latency.
"""

from datetime import UTC, datetime
import time

import pytest

from app.realtime.event_bridge import SidecarEventBridge
from app.realtime.events import RealtimeEvent
from app.realtime.performance import percentile_ms
from app.realtime.queueing import EventPriority

BURST_PROGRESS_EVENTS = 1_000
BURST_CANCEL_EVENTS = 20
BRIDGE_CAPACITY = 1024

# Local enqueue-latency budget for CRITICAL sends under burst load: this is
# SidecarEventBridge.send() returning once the event lands in the local
# BoundedEventQueue, not delivery to the sidecar.
CRITICAL_SEND_LOCAL_BUDGET_MS = 20.0


def _progress_event(index: int) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_progress_{index}",
        sequence=index,
        source="system",
        type="tool.progress",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={"tool": "search", "percent": index % 100},
        task_id=f"task_{index}",
    )


def _cancel_event(index: int) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_cancel_{index}",
        sequence=BURST_PROGRESS_EVENTS + index,
        source="system",
        type="voice.speech.cancel",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={},
    )


@pytest.mark.asyncio
async def test_critical_cancel_send_latency_under_burst_load(fake_ws_server) -> None:
    bridge = SidecarEventBridge(fake_ws_server.url, capacity=BRIDGE_CAPACITY)
    await bridge.start()

    cancel_samples_ns: list[int] = []
    max_depth = 0
    try:
        cancel_stride = BURST_PROGRESS_EVENTS // BURST_CANCEL_EVENTS
        for index in range(BURST_PROGRESS_EVENTS):
            await bridge.send(_progress_event(index), priority=EventPriority.COALESCIBLE)
            max_depth = max(max_depth, bridge.queue_depth)

            if index % cancel_stride == 0 and len(cancel_samples_ns) < BURST_CANCEL_EVENTS:
                cancel_index = len(cancel_samples_ns)
                start_ns = time.perf_counter_ns()
                await bridge.send(_cancel_event(cancel_index), priority=EventPriority.CRITICAL)
                cancel_samples_ns.append(time.perf_counter_ns() - start_ns)
                max_depth = max(max_depth, bridge.queue_depth)

        while len(cancel_samples_ns) < BURST_CANCEL_EVENTS:
            cancel_index = len(cancel_samples_ns)
            start_ns = time.perf_counter_ns()
            await bridge.send(_cancel_event(cancel_index), priority=EventPriority.CRITICAL)
            cancel_samples_ns.append(time.perf_counter_ns() - start_ns)
            max_depth = max(max_depth, bridge.queue_depth)
    finally:
        await bridge.close()

    assert len(cancel_samples_ns) == BURST_CANCEL_EVENTS
    p95_ms = percentile_ms(cancel_samples_ns, 95)
    assert p95_ms < CRITICAL_SEND_LOCAL_BUDGET_MS
    assert max_depth <= BRIDGE_CAPACITY
