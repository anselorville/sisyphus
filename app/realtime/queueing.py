import asyncio
from collections import deque
from enum import IntEnum

from .events import RealtimeEvent


class EventPriority(IntEnum):
    COALESCIBLE = 0
    DURABLE = 1
    CRITICAL = 2


class QueueClosed(RuntimeError):
    pass


_CONTROL_EVENT_TYPES = frozenset({"voice.speech.cancel"})


class BoundedEventQueue:
    def __init__(self, capacity: int) -> None:
        if capacity < 1:
            raise ValueError("capacity must be at least 1")

        self._capacity = capacity
        self._queues: dict[EventPriority, deque[RealtimeEvent]] = {
            EventPriority.CRITICAL: deque(),
            EventPriority.DURABLE: deque(),
            EventPriority.COALESCIBLE: deque(),
        }
        self._condition = asyncio.Condition()
        self._closed = False

    async def put(self, event: RealtimeEvent, priority: EventPriority) -> None:
        async with self._condition:
            if self._closed:
                raise QueueClosed("event queue is closed")

            priority = self._protected_priority(event, priority)
            if priority is EventPriority.COALESCIBLE and self._replace_coalescible(event):
                self._condition.notify()
                return

            while self._size() >= self._capacity:
                if priority is EventPriority.COALESCIBLE:
                    return
                await self._condition.wait()
                if self._closed:
                    raise QueueClosed("event queue is closed")

            self._queues[priority].append(event)
            self._condition.notify()

    async def get(self) -> RealtimeEvent:
        async with self._condition:
            while self._size() == 0:
                if self._closed:
                    raise QueueClosed("event queue is closed")
                await self._condition.wait()

            for priority in (
                EventPriority.CRITICAL,
                EventPriority.DURABLE,
                EventPriority.COALESCIBLE,
            ):
                queue = self._queues[priority]
                if queue:
                    event = queue.popleft()
                    self._condition.notify_all()
                    return event

        raise RuntimeError("event queue state is inconsistent")

    async def close(self) -> None:
        async with self._condition:
            self._closed = True
            self._condition.notify_all()

    def _size(self) -> int:
        return sum(len(queue) for queue in self._queues.values())

    def _replace_coalescible(self, event: RealtimeEvent) -> bool:
        queue = self._queues[EventPriority.COALESCIBLE]
        for index, queued_event in enumerate(queue):
            if self._coalesces(queued_event, event):
                queue[index] = event
                return True
        return False

    @staticmethod
    def _protected_priority(
        event: RealtimeEvent, priority: EventPriority
    ) -> EventPriority:
        if event.type in _CONTROL_EVENT_TYPES:
            return max(priority, EventPriority.CRITICAL)
        if event.type == "voice.transcript.final" or event.type in {
            "task.completed",
            "task.failed",
            "task.cancelled",
        }:
            return max(priority, EventPriority.DURABLE)
        return priority

    @staticmethod
    def _coalesces(queued_event: RealtimeEvent, event: RealtimeEvent) -> bool:
        if event.type == "voice.transcript.partial":
            return queued_event.type == event.type
        if event.type == "tool.progress":
            return (
                queued_event.type == event.type
                and queued_event.task_id == event.task_id
                and queued_event.payload.get("tool") == event.payload.get("tool")
            )
        return queued_event.type == event.type
