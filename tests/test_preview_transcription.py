import asyncio
import io
import wave
from unittest.mock import patch

from pipecat.frames.frames import Frame, TranscriptionFrame, VADUserStoppedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from app import model_lab_preview
from app.config import load_settings


def _silent_wav(seconds: float = 0.3, sample_rate: int = 16000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00\x00" * int(sample_rate * seconds))
    return buffer.getvalue()


class _StreamingFakeSTT(FrameProcessor):
    """Mimics a WebSocket STT: answers only after the user stops, in several finals."""

    def __init__(self, finals: list[tuple[float, str]]) -> None:
        super().__init__()
        self._finals = finals

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            for delay, text in self._finals:
                await asyncio.sleep(delay)
                await self.push_frame(
                    TranscriptionFrame(text=text, user_id="u", timestamp="now"), direction
                )


def _transcribe(stt: FrameProcessor) -> tuple[str, dict[str, int]]:
    with patch.object(model_lab_preview, "build_stt", return_value=stt):
        return asyncio.run(
            model_lab_preview.preview_transcription(
                adapter_id="cloud:transcription",
                values={},
                audio_wav_bytes=_silent_wav(),
                settings=load_settings(),
            )
        )


def test_waits_for_a_streaming_stt_that_answers_after_the_last_audio_chunk() -> None:
    # The pipeline used to be closed right after the last chunk, which dropped
    # (or truncated) the result of any provider that replies asynchronously.
    with patch.object(model_lab_preview, "STREAMING_SETTLE_SECONDS", 0.2):
        text, _timing = _transcribe(_StreamingFakeSTT([(0.3, "你好，今天天气怎么样？")]))

    assert text == "你好，今天天气怎么样？"


def test_joins_every_final_a_streaming_stt_emits_for_one_clip() -> None:
    with patch.object(model_lab_preview, "STREAMING_SETTLE_SECONDS", 0.3):
        text, _timing = _transcribe(
            _StreamingFakeSTT([(0.1, "Hello,"), (0.1, "how is the weather today?")])
        )

    assert text == "Hello, how is the weather today?"


def test_returns_empty_text_when_the_stt_never_answers() -> None:
    with (
        patch.object(model_lab_preview, "STREAMING_FINAL_TIMEOUT_SECONDS", 0.3),
        patch.object(model_lab_preview, "STREAMING_SETTLE_SECONDS", 0.1),
    ):
        text, _timing = _transcribe(_StreamingFakeSTT([]))

    assert text == ""
