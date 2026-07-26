"""Bounded, preemptible queue for sidecar-originated speech.

Distinct from ``queueing.BoundedEventQueue`` (which carries outbound
``RealtimeEvent`` telemetry to the sidecar), this queue carries *inbound*
speech the sidecar wants the agent to say out loud -- progress narration,
acknowledgements, elevation/authorization prompts, budget checks, and final
task answers. ``SpeechQueueProcessor`` drains it and turns each entry into a
``TTSSpeakFrame`` for the pipeline's TTS service to synthesize.

Barge-in (the user starts talking while the agent is speaking) must be
handled entirely inside this process: ``cancel_current()`` is a plain
in-process ``asyncio.Condition`` operation, never a network/WebSocket
round-trip to the sidecar. See ``SpeechQueueProcessor.process_frame``'s
handling of ``UserStartedSpeakingFrame`` below.
"""

import asyncio
from collections.abc import Callable
from typing import Any, Literal

import msgspec
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    StartFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .queueing import QueueClosed


SpeechKind = Literal["progress", "ack", "final", "elevation", "budget"]

DEFAULT_CAPACITY = 32

# Kinds that represent state the agent must never silently lose. Enqueuing
# one of these when the queue is full applies backpressure (blocks the
# producer) instead of dropping it -- see SpeechQueue.enqueue().
_NEVER_DROPPED_KINDS = frozenset({"final", "elevation", "budget"})


class SpeechRequest(msgspec.Struct, frozen=True):
    text: str
    kind: SpeechKind
    task_id: str
    priority: int


class SpeechQueue:
    """A bounded, priority-ordered queue of sidecar-originated speech.

    ``next()`` always returns the queued request with the highest
    ``priority`` (ties broken by insertion order), so e.g. an ``elevation``
    request enqueued after a ``progress`` request can still preempt it.

    Overflow policy (see ``enqueue``):

    - ``progress`` requests replace a queued ``progress`` request for the
      same ``task_id`` (superseded narration, e.g. "20% done" -> "80% done").
    - ``ack`` requests are replaced by a ``final`` request for the same
      ``task_id`` (the real answer supersedes its own acknowledgement).
    - ``final``, ``elevation``, and ``budget`` requests are never dropped:
      once the queue is at capacity and no replacement applies, ``enqueue``
      blocks until space frees up -- consistent with how
      ``BoundedEventQueue`` (see ``queueing.py``) applies backpressure to
      protected event types instead of dropping them.
    - Anything else (a ``progress``/``ack`` with no matching target, at
      capacity) is dropped silently.

    ``cancel_current`` implements local barge-in: it always clears whatever
    is marked as currently playing, and -- when the reason is
    ``"barge_in"`` -- also drops any still-queued ``progress`` requests
    (stale narration), while leaving ``final``/``elevation``/``ack``/
    ``budget`` requests queued so that task state is never lost to an
    interruption.
    """

    def __init__(self, capacity: int = DEFAULT_CAPACITY) -> None:
        if capacity < 1:
            raise ValueError("capacity must be at least 1")

        self._capacity = capacity
        self._items: list[SpeechRequest] = []
        self._condition = asyncio.Condition()
        self._closed = False
        self._current: str | None = None

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def current(self) -> str | None:
        """The task_id marked as currently speaking, if any."""
        return self._current

    async def enqueue(self, request: SpeechRequest) -> None:
        async with self._condition:
            if self._closed:
                raise QueueClosed("speech queue is closed")

            if request.kind == "progress" and self._replace(
                request,
                lambda item: item.kind == "progress" and item.task_id == request.task_id,
            ):
                self._condition.notify_all()
                return
            if request.kind == "final" and self._replace(
                request,
                lambda item: item.kind == "ack" and item.task_id == request.task_id,
            ):
                self._condition.notify_all()
                return

            while len(self._items) >= self._capacity:
                if request.kind not in _NEVER_DROPPED_KINDS:
                    return
                await self._condition.wait()
                if self._closed:
                    raise QueueClosed("speech queue is closed")

            self._items.append(request)
            self._condition.notify_all()

    async def next(self) -> SpeechRequest:
        async with self._condition:
            while not self._items:
                if self._closed:
                    raise QueueClosed("speech queue is closed")
                await self._condition.wait()

            request = self._pop_highest_priority()
            self._condition.notify_all()
            return request

    async def mark_speaking(self, task_id: str) -> None:
        async with self._condition:
            self._current = task_id

    async def cancel_current(self, reason: str) -> None:
        """Stop whatever is marked as currently playing, locally and immediately.

        This is a plain ``asyncio.Condition``-guarded state mutation -- it
        never awaits network/WebSocket I/O -- so it is safe to call directly
        from ``SpeechQueueProcessor`` the instant a ``UserStartedSpeakingFrame``
        arrives, with no round-trip to the sidecar.
        """
        async with self._condition:
            self._current = None
            if reason == "barge_in":
                self._items = [item for item in self._items if item.kind != "progress"]
            self._condition.notify_all()

    async def close(self) -> None:
        async with self._condition:
            self._closed = True
            self._condition.notify_all()

    def _replace(self, request: SpeechRequest, predicate: Callable[[SpeechRequest], bool]) -> bool:
        for index, item in enumerate(self._items):
            if predicate(item):
                self._items[index] = request
                return True
        return False

    def _pop_highest_priority(self) -> SpeechRequest:
        best_index = 0
        best_priority = self._items[0].priority
        for index in range(1, len(self._items)):
            if self._items[index].priority > best_priority:
                best_index = index
                best_priority = self._items[index].priority
        return self._items.pop(best_index)


class SpeechQueueProcessor(FrameProcessor):
    """Drain a ``SpeechQueue`` and speak each request via the pipeline's TTS.

    Each dequeued ``SpeechRequest`` becomes an independent ``TTSSpeakFrame``
    utterance (its own TTS turn context, not appended to any in-flight LLM
    stream -- this media pipeline has no business LLM). On
    ``UserStartedSpeakingFrame`` (barge-in), the queue's currently-playing
    marker and any stale ``progress`` requests are cancelled locally --
    synchronously with respect to network I/O, i.e. before this method
    returns -- before the frame continues downstream. See
    ``SpeechQueue.cancel_current``.
    """

    def __init__(self, queue: SpeechQueue, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._queue = queue
        self._consumer_task: asyncio.Task | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            self._consumer_task = self.create_task(self._consume_forever())
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, UserStartedSpeakingFrame):
            # Local-only: SpeechQueue.cancel_current() never awaits network
            # I/O, so barge-in cancellation is complete before this frame
            # continues downstream -- no WebSocket round-trip to the
            # sidecar is ever on this path.
            await self._queue.cancel_current("barge_in")
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, (CancelFrame, EndFrame)):
            if self._consumer_task is not None:
                await self.cancel_task(self._consumer_task)
                self._consumer_task = None
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)

    async def _consume_forever(self) -> None:
        while True:
            try:
                request = await self._queue.next()
            except QueueClosed:
                return
            await self._queue.mark_speaking(request.task_id)
            await self.push_frame(TTSSpeakFrame(text=request.text))
