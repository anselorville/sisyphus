"""Publish voice-activity signals from the media plane as realtime events.

The sidecar's HCI log (``events`` table, ``scripts/query-hci-events.sh``) can
only answer "how long until Marcus answered?" and "how often did the user cut
Marcus off?" if the media plane says when the user started and stopped
speaking and when a barge-in happened. Those facts only exist in this process
(VAD / mic-gate frames), so this processor republishes them:

- ``voice.user.started`` / ``voice.user.stopped``: the user's turn boundaries.
- ``voice.transcript.partial``: interim STT text (coalescible; high frequency).
- ``voice.speech.cancel`` (``reason=barge_in``): the user started speaking
  while Marcus was speaking. Barge-in itself is still handled locally and
  instantly by ``SpeechQueueProcessor`` / ``PreSynthQueueProcessor``; this
  event only lets the sidecar stop its own pending filler and lets the HCI log
  count interruptions.

Frames are always passed through unchanged; publishing is best-effort and a
failing sink never interrupts audio.
"""

from __future__ import annotations

import inspect
from datetime import UTC, datetime
from uuid import uuid4

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterimTranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .events import EventSequence, RealtimeEvent
from .transcription import EventSink


class VoiceActivityEventProcessor(FrameProcessor):
    """Turn VAD/turn frames into ``voice.*`` realtime events."""

    def __init__(
        self,
        event_sink: EventSink,
        sequence: EventSequence | None = None,
        **kwargs: object,
    ) -> None:
        super().__init__(**kwargs)
        self._event_sink = event_sink
        self._sequence = sequence if sequence is not None else EventSequence()
        self._bot_speaking = False
        self._last_partial = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        # Bot-speaking frames travel upstream from the output transport and
        # downstream from some services; either direction updates the flag.
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        elif isinstance(frame, UserStartedSpeakingFrame):
            self._last_partial = ""
            if self._bot_speaking:
                await self._publish("voice.speech.cancel", {"reason": "barge_in"})
            await self._publish("voice.user.started", {})
        elif isinstance(frame, UserStoppedSpeakingFrame):
            await self._publish("voice.user.stopped", {})
        elif isinstance(frame, InterimTranscriptionFrame):
            text = frame.text.strip()
            # STT services re-emit identical interim text; one event per change.
            if text and text != self._last_partial:
                self._last_partial = text
                await self._publish("voice.transcript.partial", {"text": text})
        await self.push_frame(frame, direction)

    async def _publish(self, event_type: str, payload: dict) -> None:
        event = RealtimeEvent(
            event_id=str(uuid4()),
            sequence=self._sequence.next(),
            source="pipecat",
            type=event_type,
            timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            payload=payload,
        )
        try:
            result = self._event_sink(event)
            if inspect.isawaitable(result):
                await result
        except Exception as exc:  # observability must never break the audio path
            logger.warning(f"voice activity event {event_type} not published: {exc}")
