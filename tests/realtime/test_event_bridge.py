import asyncio
from datetime import UTC, datetime

import pytest

from app.realtime.event_bridge import MAX_EVENT_BYTES, SidecarEventBridge
from app.realtime.events import RealtimeEvent


def final_transcript(*, sequence: int, text: str = "check test") -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_final_{sequence}",
        sequence=sequence,
        source="pipecat",
        type="voice.transcript.final",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload={"text": text},
    )


def event_with_payload(
    payload: dict,
    *,
    sequence: int = 1,
    event_type: str = "tool.progress",
) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_{sequence}",
        sequence=sequence,
        source="system",
        type=event_type,
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        payload=payload,
    )


async def _collect_into(bridge: SidecarEventBridge, sink: list[RealtimeEvent]) -> None:
    async for event in bridge.events():
        sink.append(event)


@pytest.mark.asyncio
async def test_unacked_durable_events_replay_after_reconnect(fake_ws_server) -> None:
    bridge = SidecarEventBridge(fake_ws_server.url, capacity=128)
    await bridge.start()
    try:
        await bridge.send(final_transcript(sequence=7))
        await fake_ws_server.disconnect_before_ack()
        await fake_ws_server.accept_reconnect()
        assert [event.sequence for event in fake_ws_server.received].count(7) == 2
    finally:
        await bridge.close()


@pytest.mark.asyncio
async def test_audio_payload_is_rejected() -> None:
    bridge = SidecarEventBridge("ws://127.0.0.1:1/events")
    with pytest.raises(ValueError, match="PCM"):
        await bridge.send(event_with_payload({"pcm": b"audio"}))


@pytest.mark.asyncio
async def test_oversized_event_is_rejected() -> None:
    bridge = SidecarEventBridge("ws://127.0.0.1:1/events")
    oversized = event_with_payload({"text": "x" * (MAX_EVENT_BYTES + 1)})
    with pytest.raises(ValueError, match="64KiB|exceeds"):
        await bridge.send(oversized)


@pytest.mark.asyncio
async def test_acked_durable_event_is_not_replayed_after_reconnect(fake_ws_server) -> None:
    bridge = SidecarEventBridge(fake_ws_server.url, capacity=128)
    await bridge.start()
    try:
        await bridge.send(final_transcript(sequence=11))
        await fake_ws_server._wait_until(lambda: len(fake_ws_server.received) >= 1)

        # Force a reconnect *after* the sidecar already ack'd -- the acked
        # event must not come back a second time.
        await fake_ws_server._connections[-1].close()
        connections_before = len(fake_ws_server._connections)
        await fake_ws_server._wait_until(lambda: len(fake_ws_server._connections) > connections_before)
        await asyncio.sleep(0.2)

        assert [event.sequence for event in fake_ws_server.received].count(11) == 1
    finally:
        await bridge.close()


@pytest.mark.asyncio
async def test_inbound_events_are_deduplicated_and_fanned_out(fake_ws_server) -> None:
    bridge = SidecarEventBridge(fake_ws_server.url, capacity=16)
    await bridge.start()

    collected: list[RealtimeEvent] = []
    subscriber_task = asyncio.create_task(_collect_into(bridge, collected))
    try:
        inbound = event_with_payload({"say": "hello"}, sequence=42, event_type="task.progress")
        await fake_ws_server.send_event_to_client(inbound)
        await fake_ws_server.send_event_to_client(inbound)  # duplicate: must be deduped

        async def _wait_for_delivery() -> None:
            while not collected:
                await asyncio.sleep(0.01)

        await asyncio.wait_for(_wait_for_delivery(), timeout=2.0)
        await asyncio.sleep(0.1)  # give a wrongly-undeduped copy a chance to arrive
    finally:
        await bridge.close()
        await asyncio.wait_for(subscriber_task, timeout=1.0)

    assert len(collected) == 1
    assert collected[0].sequence == 42


@pytest.mark.asyncio
async def test_close_cancels_tasks_and_releases_subscriptions(fake_ws_server) -> None:
    bridge = SidecarEventBridge(fake_ws_server.url, capacity=16)
    await bridge.start()

    collected: list[RealtimeEvent] = []
    subscriber_task = asyncio.create_task(_collect_into(bridge, collected))
    await asyncio.sleep(0.05)  # let the connection establish

    await bridge.close()
    await asyncio.wait_for(subscriber_task, timeout=1.0)  # events() must terminate, not hang

    remaining_bridge_tasks = [
        task
        for task in asyncio.all_tasks()
        if not task.done() and task.get_name() in {"sidecar-bridge-sender", "sidecar-bridge-receiver"}
    ]
    assert not remaining_bridge_tasks

    # close() must be idempotent.
    await bridge.close()
