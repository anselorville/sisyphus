import asyncio
from dataclasses import dataclass
from typing import Any

from pipecat.frames.frames import (
    CancelFrame,
    DataFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InputTransportMessageFrame,
    InterruptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class MicStateFrame(DataFrame):
    """Mic open/close state change emitted downstream with ordered audio/text."""

    open: bool = False


MIC_CLOSE_AUDIO_GRACE_SECONDS = 0.2


class MicGateProcessor(FrameProcessor):
    """Convert manual mic messages into turn frames and gate closed-mic audio."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._mic_open = False
        self._pending_close: asyncio.Task | None = None

    @staticmethod
    def _is_mic_message(frame: InputTransportMessageFrame) -> bool:
        return isinstance(frame.message, dict) and frame.message.get("type") == "mic"

    async def _emit_stop_after_grace(self, direction: FrameDirection) -> None:
        await asyncio.sleep(MIC_CLOSE_AUDIO_GRACE_SECONDS)
        await self.push_frame(VADUserStoppedSpeakingFrame(), direction)
        await self.push_frame(UserStoppedSpeakingFrame(), direction)
        self._pending_close = None

    async def _cancel_pending_close(self) -> None:
        if self._pending_close is not None and not self._pending_close.done():
            self._pending_close.cancel()
        self._pending_close = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, InputTransportMessageFrame) and self._is_mic_message(frame):
            open_requested = bool(frame.message.get("open"))
            if open_requested and not self._mic_open:
                self._mic_open = True
                await self._cancel_pending_close()
                await self.push_frame(MicStateFrame(open=True), direction)
                await self.push_frame(VADUserStartedSpeakingFrame(), direction)
                await self.push_frame(UserStartedSpeakingFrame(), direction)
            elif not open_requested and self._mic_open:
                self._mic_open = False
                await self._cancel_pending_close()
                await self.push_frame(MicStateFrame(open=False), direction)
                self._pending_close = asyncio.ensure_future(
                    self._emit_stop_after_grace(direction)
                )
            return

        if (
            isinstance(frame, InputAudioRawFrame)
            and not self._mic_open
            and self._pending_close is None
        ):
            frame.audio = b"\x00" * len(frame.audio)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, (CancelFrame, EndFrame)):
            await self._cancel_pending_close()

        await self.push_frame(frame, direction)


class TTSOutputGateProcessor(FrameProcessor):
    """Hold TTS output while the mic is open and release it at mic close."""

    _GATED_FRAME_TYPES = (TTSStartedFrame, TTSAudioRawFrame, TTSTextFrame, TTSStoppedFrame)

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._holding = False
        self._buffer: list[tuple[Frame, FrameDirection]] = []

    async def _flush(self) -> None:
        buffered, self._buffer = self._buffer, []
        for buffered_frame, buffered_direction in buffered:
            await self.push_frame(buffered_frame, buffered_direction)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, MicStateFrame):
            self._holding = frame.open
            if not frame.open:
                await self._flush()
            return

        if isinstance(frame, InterruptionFrame):
            self._buffer.clear()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, (CancelFrame, EndFrame)):
            self._buffer.clear()
            await self.push_frame(frame, direction)
            return

        if self._holding and isinstance(frame, self._GATED_FRAME_TYPES):
            self._buffer.append((frame, direction))
            return

        await self.push_frame(frame, direction)
