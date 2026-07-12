"""VoxCPM2-CUDA streaming TTS service.

Adapter for the LAN-hosted VoxCPM2 endpoint:

    POST /v1/tts/stream
      -> SSE events where each `chunk` data payload is base64 WAV bytes

Each WAV chunk is independent and can be decoded immediately, which maps well
to Pipecat's `TTSAudioRawFrame` streaming contract.
"""

from __future__ import annotations

import base64
import io
import json
import wave
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService

from app.config import Settings


VOXCPM2_CUDA_PROVIDER = "VoxCPM2-CUDA"
VOXCPM2_CUDA_DEFAULT_MODEL = "streaming"


def wav_chunk_to_audio_frame(wav_bytes: bytes) -> TTSAudioRawFrame:
    """Decode one independent WAV chunk into a Pipecat raw audio frame."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        num_channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        if sample_width != 2:
            raise ValueError(f"VoxCPM2-CUDA WAV chunk must be 16-bit PCM, got {sample_width * 8}-bit")
        pcm = wav_file.readframes(wav_file.getnframes())
    return TTSAudioRawFrame(audio=pcm, sample_rate=sample_rate, num_channels=num_channels)


def _voice_design_text(text: str, voice_design: str | None) -> str:
    design = (voice_design or "").strip()
    if not design:
        return text
    if design.startswith("(") and design.endswith(")"):
        return f"{design}{text}"
    return f"({design}){text}"


class VoxCPM2CUDATTSService(TTSService):
    """Pipecat TTS adapter for the LAN VoxCPM2-CUDA SSE API."""

    def __init__(
        self,
        *,
        base_url: str,
        seed: int = 42,
        cfg_value: float = 2.0,
        inference_timesteps: int = 5,
        voice_design: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(push_start_frame=True, push_stop_frames=True, **kwargs)
        self._base_url = base_url.rstrip("/")
        self._seed = seed
        self._cfg_value = cfg_value
        self._inference_timesteps = inference_timesteps
        self._voice_design = voice_design

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        request_text = _voice_design_text(text, self._voice_design)
        payload = {
            "text": request_text,
            "seed": self._seed,
            "cfg_value": self._cfg_value,
            "inference_timesteps": self._inference_timesteps,
        }
        url = f"{self._base_url}/v1/tts/stream"
        logger.debug(f"{self}: Generating TTS via VoxCPM2-CUDA [{text}] url={url}")

        await self.start_tts_usage_metrics(text)
        saw_audio = False
        event: str | None = None

        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", url, json=payload) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line:
                            continue
                        if line.startswith("event: "):
                            event = line[7:].strip()
                            continue
                        if not line.startswith("data: "):
                            continue

                        data = line[6:].strip()
                        if event == "done" or data.startswith("{"):
                            if data.startswith("{"):
                                logger.debug(f"{self}: VoxCPM2-CUDA stream done {json.loads(data)}")
                            break

                        wav_bytes = base64.b64decode(data)
                        frame = wav_chunk_to_audio_frame(wav_bytes)
                        if not saw_audio:
                            await self.stop_ttfb_metrics()
                            saw_audio = True
                        yield frame

            if not saw_audio:
                logger.warning(f"{self}: VoxCPM2-CUDA returned no audio for [{text!r}]")
        except Exception as e:
            logger.error(f"{self}: VoxCPM2-CUDA TTS error: {e}")
            yield ErrorFrame(error=f"VoxCPM2-CUDA TTS error: {e}")
        finally:
            await self.stop_processing_metrics()


def build_voxcpm2_cuda_tts(
    settings: Settings,
    *,
    voice_design: str | None = None,
) -> VoxCPM2CUDATTSService:
    resolved_voice_design = voice_design or settings.voxcpm2_cuda_voice_design
    return VoxCPM2CUDATTSService(
        base_url=settings.voxcpm2_cuda_base_url,
        seed=settings.voxcpm2_cuda_seed,
        cfg_value=settings.voxcpm2_cuda_cfg_value,
        inference_timesteps=settings.voxcpm2_cuda_inference_timesteps,
        voice_design=resolved_voice_design,
        settings=TTSSettings(
            model=VOXCPM2_CUDA_DEFAULT_MODEL,
            voice=resolved_voice_design,
            language=None,
        ),
    )
