import asyncio

import pytest

from app.realtime.events import RealtimeEvent
from app.realtime.queueing import BoundedEventQueue, EventPriority, QueueClosed


def make_event(
    event_type: str,
    payload: dict,
    *,
    task_id: str | None = None,
) -> RealtimeEvent:
    return RealtimeEvent(
        event_id=f"evt_{event_type}_{payload}",
        sequence=1,
        source="system",
        type=event_type,
        timestamp="2026-07-25T12:00:00Z",
        payload=payload,
        task_id=task_id,
    )


@pytest.mark.asyncio
async def test_latest_partial_replaces_older_partial() -> None:
    queue = BoundedEventQueue(capacity=2)
    await queue.put(
        make_event("voice.transcript.partial", {"text": "old"}),
        EventPriority.COALESCIBLE,
    )
    await queue.put(
        make_event("voice.transcript.partial", {"text": "new"}),
        EventPriority.COALESCIBLE,
    )

    assert (await queue.get()).payload["text"] == "new"


@pytest.mark.asyncio
async def test_tool_progress_replaces_prior_progress_for_same_task() -> None:
    queue = BoundedEventQueue(capacity=2)
    await queue.put(
        make_event("tool.progress", {"tool": "search", "percent": 20}, task_id="task_1"),
        EventPriority.COALESCIBLE,
    )
    await queue.put(
        make_event("tool.progress", {"tool": "search", "percent": 80}, task_id="task_1"),
        EventPriority.COALESCIBLE,
    )

    assert (await queue.get()).payload["percent"] == 80


@pytest.mark.asyncio
async def test_critical_event_is_delivered_before_lower_priorities() -> None:
    queue = BoundedEventQueue(capacity=3)
    await queue.put(make_event("task.progress", {}), EventPriority.COALESCIBLE)
    await queue.put(make_event("task.started", {}), EventPriority.DURABLE)
    await queue.put(make_event("voice.speech.cancel", {}), EventPriority.CRITICAL)

    assert (await queue.get()).type == "voice.speech.cancel"
    assert (await queue.get()).type == "task.started"


@pytest.mark.asyncio
async def test_critical_event_waits_for_space_instead_of_being_dropped() -> None:
    queue = BoundedEventQueue(capacity=1)
    await queue.put(make_event("voice.transcript.final", {"text": "final"}), EventPriority.DURABLE)

    blocked_put = asyncio.create_task(
        queue.put(make_event("voice.speech.cancel", {}), EventPriority.CRITICAL)
    )
    await asyncio.sleep(0)
    assert not blocked_put.done()

    assert (await queue.get()).type == "voice.transcript.final"
    await blocked_put
    assert (await queue.get()).type == "voice.speech.cancel"


@pytest.mark.asyncio
async def test_transcript_final_is_not_dropped_when_marked_coalescible() -> None:
    queue = BoundedEventQueue(capacity=1)
    await queue.put(make_event("task.started", {}), EventPriority.DURABLE)

    blocked_put = asyncio.create_task(
        queue.put(
            make_event("voice.transcript.final", {"text": "final"}),
            EventPriority.COALESCIBLE,
        )
    )
    await asyncio.sleep(0)
    assert not blocked_put.done()

    assert (await queue.get()).type == "task.started"
    await blocked_put
    assert (await queue.get()).type == "voice.transcript.final"


@pytest.mark.asyncio
async def test_close_drains_queued_events_then_rejects_consumers_and_producers() -> None:
    queue = BoundedEventQueue(capacity=1)
    await queue.put(make_event("voice.transcript.final", {"text": "final"}), EventPriority.DURABLE)
    await queue.close()

    assert (await queue.get()).type == "voice.transcript.final"
    with pytest.raises(QueueClosed):
        await queue.get()
    with pytest.raises(QueueClosed):
        await queue.put(make_event("task.progress", {}), EventPriority.COALESCIBLE)
