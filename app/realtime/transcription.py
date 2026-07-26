"""Realtime transcript publication and injectable speech input."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from uuid import uuid4

from pipecat.frames.frames import Frame, TranscriptionFrame, TTSTextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .events import RealtimeEvent


EventSink = Callable[[RealtimeEvent], Awaitable[None] | None]


class TranscriptEventProcessor(FrameProcessor):
    """Publish final STT text as structured realtime events."""

    def __init__(self, event_sink: EventSink, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._event_sink = event_sink
        self._sequence = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self._sequence += 1
            event = RealtimeEvent(
                event_id=str(uuid4()),
                sequence=self._sequence,
                source="pipecat",
                type="voice.transcript.final",
                timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                payload={"text": frame.text.strip(), "user_id": frame.user_id},
            )
            result = self._event_sink(event)
            if inspect.isawaitable(result):
                await result
        await self.push_frame(frame, direction)


class SpeechInputProcessor(FrameProcessor):
    """Deliver final speech input to an injected agent link.

    The link may be a callable or expose ``on_transcript``. Returning text
    produces a ``TTSTextFrame``; later sidecar work can replace this narrow
    adapter without changing the media pipeline's audio boundaries.
    """

    def __init__(self, agent_link: object | None, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._agent_link = agent_link

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if not isinstance(frame, TranscriptionFrame):
            await self.push_frame(frame, direction)
            return

        result = self._send(frame)
        if inspect.isawaitable(result):
            result = await result
        if isinstance(result, str) and result.strip():
            await self.push_frame(TTSTextFrame(text=result.strip()), direction)

    def _send(self, frame: TranscriptionFrame) -> object | None:
        if self._agent_link is None:
            return None
        handler = getattr(self._agent_link, "on_transcript", None)
        if callable(handler):
            return handler(frame)
        if callable(self._agent_link):
            return self._agent_link(frame)
        return None
