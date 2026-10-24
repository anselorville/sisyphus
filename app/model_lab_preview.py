"""STT and TTS preview helpers for the media-plane runtime."""

from __future__ import annotations

import asyncio
import io
import time
import wave
from typing import Any

from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.tests.utils import run_test
from pipecat.workers.runner import WorkerRunner

from app.config import Settings
from app.providers import build_stt, build_tts


class PreviewError(ValueError):
    """Raised when a requested preview is not available in the media plane."""


def _audio_duration_ms(wav_bytes: bytes) -> int:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
        return round(wav_file.getnframes() / wav_file.getframerate() * 1000)


def _wav_bytes_from_frames(frames: list[TTSAudioRawFrame]) -> bytes:
    if not frames:
        raise PreviewError("TTS service produced no audio frames.")
    sample_rate = frames[0].sample_rate
    num_channels = frames[0].num_channels
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(num_channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"".join(frame.audio for frame in frames))
    return buffer.getvalue()


async def preview_text(**_kwargs: Any) -> tuple[str, dict[str, int]]:
    raise PreviewError("Text previews are unavailable in the media-plane runtime.")


async def preview_chain(**_kwargs: Any) -> tuple[dict, bytes]:
    raise PreviewError("Chain previews are unavailable in the media-plane runtime.")


async def preview_speech(
    *, adapter_id: str, values: dict[str, Any], input_text: str, settings: Settings
) -> tuple[bytes, dict[str, int]]:
    if adapter_id not in {"cloud:speech", "omlx:voxcpm2"}:
        raise PreviewError(f"Unknown or unsupported speech adapter id: {adapter_id!r}")
    start_time = time.monotonic()
    down, _up = await run_test(build_tts(settings), frames_to_send=[TTSSpeakFrame(input_text)])
    wav_bytes = _wav_bytes_from_frames(
        [frame for frame in down if isinstance(frame, TTSAudioRawFrame)]
    )
    return wav_bytes, {
        "total_ms": round((time.monotonic() - start_time) * 1000),
        "audio_ms": _audio_duration_ms(wav_bytes),
    }


def _pcm_chunks_from_wav(wav_bytes: bytes, *, chunk_ms: int = 100) -> tuple[list[bytes], int, int]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
        if wav_file.getsampwidth() != 2:
            raise PreviewError("Uploaded audio must be 16-bit PCM WAV.")
        sample_rate = wav_file.getframerate()
        num_channels = wav_file.getnchannels()
        frames_per_chunk = max(1, int(sample_rate * chunk_ms / 1000))
        chunks: list[bytes] = []
        while chunk := wav_file.readframes(frames_per_chunk):
            chunks.append(chunk)
    return chunks, sample_rate, num_channels


# How long a streaming STT (Deepgram, AssemblyAI, ...) may take to return its
# first final transcript after the last audio chunk. Batch providers return as
# soon as the utterance ends, so this only bounds the worst case.
STREAMING_FINAL_TIMEOUT_SECONDS = 10.0
# Streaming STT emits one final per detected turn, so one clip can yield several.
# After the first, keep collecting until the service has been quiet this long.
STREAMING_SETTLE_SECONDS = 1.5


class _TranscriptionCollector(FrameProcessor):
    """Collects every final transcript and signals each arrival."""

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.arrived = asyncio.Event()

    @property
    def text(self) -> str:
        return " ".join(part.strip() for part in self.parts if part.strip())

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            self.parts.append(frame.text)
            self.arrived.set()
        await self.push_frame(frame, direction)


async def preview_transcription(
    *, adapter_id: str, values: dict[str, Any], audio_wav_bytes: bytes, settings: Settings
) -> tuple[str, dict[str, int]]:
    if adapter_id not in {"cloud:transcription", "omlx:nemotron_asr", "omlx:qwen3_asr"}:
        raise PreviewError(f"Unknown or unsupported transcription adapter id: {adapter_id!r}")
    chunks, sample_rate, num_channels = _pcm_chunks_from_wav(audio_wav_bytes)
    frames: list[Frame] = [VADUserStartedSpeakingFrame()]
    frames.extend(
        InputAudioRawFrame(audio=chunk, sample_rate=sample_rate, num_channels=num_channels)
        for chunk in chunks
    )
    frames.append(VADUserStoppedSpeakingFrame())
    start_time = time.monotonic()
    stt = build_stt(settings)
    sink = _TranscriptionCollector()
    worker = PipelineWorker(Pipeline([stt, sink]), cancel_on_idle_timeout=False)
    # Segmented (batch) STT answers once per utterance; only streaming services
    # need the settle window to gather their remaining finals.
    settle_seconds = 0.0 if isinstance(stt, SegmentedSTTService) else STREAMING_SETTLE_SECONDS

    async def drive() -> None:
        await asyncio.sleep(0.01)
        for frame in frames:
            await worker.queue_frame(frame)
        # Do not end the pipeline until the STT has answered: closing it first
        # truncates or drops the result of streaming (WebSocket) providers.
        try:
            await asyncio.wait_for(sink.arrived.wait(), STREAMING_FINAL_TIMEOUT_SECONDS)
            while settle_seconds:
                sink.arrived.clear()
                await asyncio.wait_for(sink.arrived.wait(), settle_seconds)
        except asyncio.TimeoutError:
            pass
        await worker.queue_frame(EndFrame())

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await asyncio.gather(runner.run(), drive())
    return sink.text, {"total_ms": round((time.monotonic() - start_time) * 1000)}
