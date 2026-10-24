import asyncio
import re
from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy
from pipecat.turns.user_stop.base_user_turn_stop_strategy import BaseUserTurnStopStrategy


_SENTENCE_END_RE = re.compile(r"[。！？!?]+")

# Maximum extra wait for an unpunctuated final STT fragment. This delay sits
# directly inside the user-perceived user-stop -> bot-speech latency budget.
SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS = 0.5

# After the user stops speaking, the segment that just ended is still being
# transcribed (a batch STT such as Zhipu takes ~0.6s), so a buffered fragment
# must wait this much longer for it before being released. It only applies when
# text was already buffered; a normal single-segment turn never waits for it.
SEMANTIC_BUFFER_SEGMENT_WAIT_SECONDS = 1.2

# Upper bound on holding a buffered fragment while the user is (apparently)
# still speaking, in case the matching stop frame is lost.
SEMANTIC_BUFFER_MAX_HOLD_SECONDS = 10.0


class SemanticBufferProcessor(FrameProcessor):
    """Buffers STT transcription fragments until a sentence boundary is reached,
    then forwards semantically complete sentences to the LLM while keeping any
    incomplete remainder buffered for the next incoming fragment.

    Why this is needed: Deepgram streaming STT emits a final TranscriptionFrame
    per VAD-detected utterance. In real environments (background noise, speech
    hesitations, fast talking), utterances are frequently fragmented mid-sentence
    -- e.g. "我手里有你要的东" before "西。" arrives separately. Sending each
    fragment directly to the LLM causes garbage translations of incomplete inputs
    and leaves the LLM guessing at truncated meaning.

    This processor solves it by:
    1. Accumulating each TranscriptionFrame's text into a rolling buffer
    2. On each append, checking if the buffer ends with terminal punctuation
       (。！？!?) -- Deepgram adds punctuation via `punctuate=True`
    3. If yes: extracting everything up to (and including) the last sentence-end,
       pushing it as a single complete TranscriptionFrame, and keeping any
       remainder buffered
    4. If no: starting a flush timer (`flush_timeout` seconds). If no new
       fragment arrives before the timer fires, the buffer is force-flushed so
       the pipeline never stalls (handles unpunctuated speech or a long trailing
       pause)

    Mid-sentence pauses: the VAD ends a segment at any pause longer than its
    `stop_secs` (0.2s by default), so a natural comma pause splits one sentence
    into two segments, and the first one's transcript arrives while the user
    has already started the second. The buffer therefore tracks
    UserStarted/StoppedSpeakingFrame: while the user is speaking again, a
    buffered fragment is held (no flush timer); once they stop it waits for
    the segment still being transcribed. Single-segment turns are unaffected.

    Position in pipeline: AFTER `original_tap` (so the UI immediately shows
    raw transcription fragments for real-time feedback) but BEFORE
    `user_aggregator` (so the LLM only ever sees complete sentences).
    """

    def __init__(
        self,
        flush_timeout: float = SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS,
        segment_wait: float = SEMANTIC_BUFFER_SEGMENT_WAIT_SECONDS,
        max_hold: float = SEMANTIC_BUFFER_MAX_HOLD_SECONDS,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._buffer: str = ""
        self._flush_timeout = flush_timeout
        self._segment_wait = segment_wait
        self._max_hold = max_hold
        self._user_speaking = False
        self._flush_task: "asyncio.Task[None] | None" = None
        self._last_user_id: str = ""
        self._last_timestamp: str = ""

    @property
    def buffered_text(self) -> str:
        """Return the transcription suffix still awaiting a turn boundary."""
        return self._buffer

    def _split_at_last_sentence_end(self, text: str) -> tuple[str, str]:
        """Split at the last terminal punctuation in text.

        Returns (complete_part, remainder). `complete_part` is everything up
        to and including the last sentence-end marker; `remainder` is whatever
        follows (may be empty). Returns ("", text) if no terminal punctuation
        is found.
        """
        matches = list(_SENTENCE_END_RE.finditer(text))
        if not matches:
            return "", text
        last_end = matches[-1].end()
        return text[:last_end].strip(), text[last_end:].strip()

    async def _cancel_flush_timer(self) -> None:
        if self._flush_task and not self._flush_task.done():
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
        self._flush_task = None

    @staticmethod
    def _join(buffered: str, text: str) -> str:
        """Concatenate two transcript fragments, spacing only where words would fuse."""
        if buffered and text and buffered[-1].isascii() and buffered[-1].isalnum() and text[0].isascii() and text[0].isalnum():
            return f"{buffered} {text}"
        return buffered + text

    def _start_flush_timer(self, direction: FrameDirection, timeout: float | None = None) -> None:
        self._flush_task = asyncio.ensure_future(self._schedule_flush(direction, timeout))

    async def _schedule_flush(self, direction: FrameDirection, timeout: float | None = None) -> None:
        try:
            await asyncio.sleep(self._flush_timeout if timeout is None else timeout)
            if self._buffer:
                logger.debug(
                    f"{self}: Force-flushing incomplete buffer [{self._buffer}]"
                )
                await self._flush_buffer(direction)
        except asyncio.CancelledError:
            pass

    async def _flush_buffer(self, direction: FrameDirection) -> None:
        """Push the pending transcription once and clear it atomically."""
        text = self._buffer.strip()
        self._buffer = ""
        if text:
            await self.push_frame(
                TranscriptionFrame(
                    text=text,
                    user_id=self._last_user_id,
                    timestamp=self._last_timestamp,
                ),
                direction,
            )

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            await self._cancel_flush_timer()
            text = frame.text.strip()
            if not text:
                return

            self._last_user_id = frame.user_id
            self._last_timestamp = frame.timestamp
            self._buffer = self._join(self._buffer, text) if self._buffer else text

            complete, remainder = self._split_at_last_sentence_end(self._buffer)
            if complete:
                self._buffer = remainder
                await self.push_frame(
                    TranscriptionFrame(text=complete, user_id=frame.user_id, timestamp=frame.timestamp),
                    direction,
                )
                if remainder:
                    self._start_flush_timer(direction, self._max_hold if self._user_speaking else None)
            else:
                # Still speaking: the rest of the sentence is on its way, hold.
                self._start_flush_timer(direction, self._max_hold if self._user_speaking else None)
            return

        if isinstance(frame, UserStartedSpeakingFrame):
            self._user_speaking = True
            if self._buffer:
                await self._cancel_flush_timer()
                self._start_flush_timer(direction, self._max_hold)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, UserStoppedSpeakingFrame):
            self._user_speaking = False
            if self._buffer:
                # The segment that just ended is still being transcribed; give
                # it the chance to join the held fragment before releasing it.
                await self._cancel_flush_timer()
                self._start_flush_timer(direction, self._flush_timeout + self._segment_wait)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, CancelFrame):
            await self._cancel_flush_timer()
            self._buffer = ""
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, EndFrame):
            await self._cancel_flush_timer()
            await self._flush_buffer(direction)
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)


class SentenceUserTurnStopStrategy(BaseUserTurnStopStrategy):
    """End the user turn on every final, sentence-complete transcription."""

    async def process_frame(self, frame: Frame):  # type: ignore[override]
        from pipecat.turns.types import ProcessFrameResult

        if type(frame) is TranscriptionFrame:
            await self.trigger_user_turn_stopped()
            return ProcessFrameResult.STOP
        return ProcessFrameResult.CONTINUE


class MicButtonUserTurnStartStrategy(BaseUserTurnStartStrategy):
    """Start manual turns from a mic-button-emitted speaking frame."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(enable_interruptions=True, enable_user_speaking_frames=False, **kwargs)

    async def process_frame(self, frame: Frame):  # type: ignore[override]
        from pipecat.turns.types import ProcessFrameResult

        if isinstance(frame, UserStartedSpeakingFrame):
            await self.trigger_user_turn_started()
            return ProcessFrameResult.STOP
        return ProcessFrameResult.CONTINUE
