"""Pre-synthesis scheduler: concurrent TTS with in-order playback.

Why this exists: the TTS service serializes every utterance (a single
WebSocket connection cannot interleave two synthesis requests, so
`run_tts` holds an asyncio.Lock). That means utterance B's synthesis does
not even start until A's audio fully arrives -- the user hears a pause
between sentences equal to the *full* synthesis time of the previous one,
not just its playback.

This processor fixes that with a pre-synthesis pool:

  SpeechQueue ──┬─ worker[0] (own TTS connection) ─┐
                ├─ worker[1] (own TTS connection) ─┼─► ordered audio buffer ─► downstream
                └─ worker[2] (own TTS connection) ─┘

- N workers each own an independent TTS service instance (hence N
  independent WebSocket connections, each with its own lock).
- Every worker pulls the next speech request and synthesizes it to audio
  chunks tagged with its sequence number.
- A single playback coroutine drains the chunks IN SEQUENCE ORDER, so
  utterance A's audio is always played before B's, but B was already
  synthesized while A was still playing -- no inter-sentence pause from
  waiting on synthesis.

Barge-in (`UserStartedSpeakingFrame`) cancels synthesis and playback and
drops unplayed audio, matching the old single-consumer behavior.
"""

from __future__ import annotations

import asyncio
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    StartFrame,
    TTSAudioRawFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.tts_service import TTSService

from .speech_queue import QueueClosed, SpeechQueue, SpeechRequest


class PreSynthQueueProcessor(FrameProcessor):
    """Concurrent TTS pre-synthesis with in-order playback (see module doc)."""

    def __init__(
        self,
        queue: SpeechQueue,
        *,
        tts_factory,
        concurrency: int = 3,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._queue = queue
        self._tts_factory = tts_factory
        self._concurrency = max(1, concurrency)
        self._workers: list[asyncio.Task] = []
        self._playback_task: asyncio.Task | None = None

        # seq -> audio chunks, in request order; playback drains from the
        # lowest available seq only.
        self._next_seq = 0
        self._pending: dict[int, list[TTSAudioRawFrame]] = {}
        self._chunk_condition = asyncio.Condition()
        self._closed = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            self._playback_task = self.create_task(self._playback_loop())
            for _ in range(self._concurrency):
                worker = self.create_task(self._synthesis_worker())
                self._workers.append(worker)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, UserStartedSpeakingFrame):
            # Barge-in: stop synthesis and playback, drop unplayed audio.
            for worker in self._workers:
                await self.cancel_task(worker)
            self._workers = []
            if self._playback_task is not None:
                await self.cancel_task(self._playback_task)
                self._playback_task = None
            self._pending.clear()
            self._next_seq = 0
            await self._queue.cancel_current("barge_in")
            if not self._closed:
                self._playback_task = self.create_task(self._playback_loop())
                for _ in range(self._concurrency):
                    worker = self.create_task(self._synthesis_worker())
                    self._workers.append(worker)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, (CancelFrame, EndFrame)):
            self._closed = True
            for worker in self._workers:
                await self.cancel_task(worker)
            self._workers = []
            if self._playback_task is not None:
                await self.cancel_task(self._playback_task)
                self._playback_task = None
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)

    async def _synthesis_worker(self) -> None:
        # Each worker owns an independent TTS instance: the underlying
        # service serializes per-instance (one WS connection), so N workers
        # give us N concurrent synthesis lanes.
        tts = self._tts_factory()
        try:
            while not self._closed:
                try:
                    request = await self._queue.next()
                except QueueClosed:
                    return
                seq = self._next_seq
                self._next_seq += 1
                try:
                    chunks: list[TTSAudioRawFrame] = []
                    async for frame in tts.run_tts(request.text, str(seq)):
                        if isinstance(frame, TTSAudioRawFrame):
                            chunks.append(frame)
                    async with self._chunk_condition:
                        self._pending[seq] = chunks
                        self._chunk_condition.notify_all()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning(f"[pre-synth] TTS failed for seq {seq}: {exc}")
                    async with self._chunk_condition:
                        self._pending[seq] = []
                        self._chunk_condition.notify_all()
        finally:
            await tts.stop(None)

    async def _playback_loop(self) -> None:
        next_to_play = 0
        try:
            while not self._closed:
                async with self._chunk_condition:
                    while next_to_play not in self._pending and not self._closed:
                        await self._chunk_condition.wait()
                    if self._closed:
                        return
                    chunks = self._pending.pop(next_to_play)
                next_to_play += 1
                for chunk in chunks:
                    await self.push_frame(chunk)
        except asyncio.CancelledError:
            return
