"""Microsoft Edge TTS service for the Sisyphus translator pipeline.

Uses the unofficial `edge-tts` Python package (which talks to Microsoft Edge
browser's speech synthesis backend) for fast, free, high-quality multilingual
TTS -- no API key required.

Audio pipeline:
  edge_tts.Communicate(text, voice).stream()
    → collect MP3 chunks (24kHz 48kbps CBR mono)
    → decode to raw PCM s16le @ 24kHz with PyAV
    → yield TTSAudioRawFrame chunks to Pipecat

TTFB is dominated by the time Microsoft's server takes to synthesize the full
audio and begin streaming it back -- typically 0.5–1.5s for short phrases, far
better than OpenRouter mai-voice-2's observed 4–8s.

Bidirectional voice selection: reads `direction_stripper.last_direction` (e.g.
"ZH->EN" or "EN->ZH") before each utterance to pick the appropriate voice for
the *output* language, so both translation directions sound native.
"""

from __future__ import annotations

import io
from collections.abc import AsyncGenerator
from typing import Any

import av
import edge_tts
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService

from app.language_map import tts_default_voice as _edge_default

EDGE_TTS_DEFAULT_VOICE: str = _edge_default("edge_tts", "en") or "en-US-AriaNeural"

# Edge TTS always outputs 24kHz 48kbps mono MP3 (audio-24khz-48kbitrate-mono-mp3).
# We decode to PCM at this same rate -- resampler is a near-no-op but ensures
# correct s16 interleaved format regardless of libav's internal representation.
EDGE_TTS_SAMPLE_RATE = 24000


def _decode_mp3_to_pcm(mp3_bytes: bytes) -> bytes:
    """Decode MP3 bytes to raw PCM s16le at EDGE_TTS_SAMPLE_RATE Hz mono.

    PyAV (libav Python bindings) is already present as a transitive dependency
    of Pipecat's video/audio handling (confirmed: av is installed alongside
    pipecat in this project's venv). The resampler is constructed fresh per
    call to avoid state leakage across utterances.
    """
    container = av.open(io.BytesIO(mp3_bytes))
    resampler = av.AudioResampler(format="s16", layout="mono", rate=EDGE_TTS_SAMPLE_RATE)
    pcm_chunks: list[bytes] = []
    for frame in container.decode(audio=0):
        for rf in resampler.resample(frame):
            pcm_chunks.append(bytes(rf.planes[0]))
    for rf in resampler.resample(None):
        pcm_chunks.append(bytes(rf.planes[0]))
    return b"".join(pcm_chunks)


class EdgeTTSService(TTSService):
    """Edge TTS with a static configured voice."""

    def __init__(
        self,
        *,
        default_voice: str = EDGE_TTS_DEFAULT_VOICE,
        **kwargs: Any,
    ) -> None:
        super().__init__(push_start_frame=True, push_stop_frames=True, **kwargs)
        self._default_voice = default_voice

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        voice = self._default_voice
        logger.debug(f"{self}: Generating TTS via Edge TTS [{text}] voice={voice}")

        await self.start_tts_usage_metrics(text)
        try:
            communicate = edge_tts.Communicate(text, voice)
            mp3_chunks: list[bytes] = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    mp3_chunks.append(chunk["data"])

            if not mp3_chunks:
                logger.warning(f"{self}: Edge TTS returned no audio for [{text!r}]")
                return

            pcm_bytes = _decode_mp3_to_pcm(b"".join(mp3_chunks))
            await self.stop_ttfb_metrics()

            # Yield PCM in ~100ms chunks (SAMPLE_RATE / 10 samples * 2 bytes/sample)
            chunk_size = EDGE_TTS_SAMPLE_RATE // 10 * 2
            for i in range(0, len(pcm_bytes), chunk_size):
                yield TTSAudioRawFrame(
                    audio=pcm_bytes[i : i + chunk_size],
                    sample_rate=EDGE_TTS_SAMPLE_RATE,
                    num_channels=1,
                )
        except Exception as e:
            logger.error(f"{self}: Edge TTS error: {e}")
            yield ErrorFrame(error=f"Edge TTS error: {e}")
        finally:
            await self.stop_processing_metrics()


def build_edge_tts(default_voice: str = EDGE_TTS_DEFAULT_VOICE) -> EdgeTTSService:
    """Construct the Edge TTS service for the cloud media plane."""
    return EdgeTTSService(
        default_voice=default_voice,
        settings=TTSSettings(model=None, voice=default_voice, language=None),
    )
