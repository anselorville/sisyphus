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

# Voices selected for natural-sounding output in each language.
# XiaoxiaoNeural: Microsoft's recommended Mandarin Chinese neural voice.
# AriaNeural: Microsoft's recommended US English neural voice for assistant use.
EDGE_TTS_VOICES: dict[str, str] = {
    "zh": "zh-CN-XiaoxiaoNeural",
    "en": "en-US-AriaNeural",
}

EDGE_TTS_DEFAULT_VOICE = "en-US-AriaNeural"

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


class ToneAwareEdgeTTSService(TTSService):
    """Edge TTS with automatic voice selection by translation direction.

    Reads `tone_source.last_direction` (e.g. "ZH->EN") before each utterance
    synthesis call and picks the Edge TTS voice for the *destination* language.
    Falls back to `default_voice` when no direction has been parsed yet (the
    first utterance of a session, before TranslationDirectionStripper has
    emitted any tag).

    `tone_source` is a reference to the pipeline's TranslationDirectionStripper
    instance. Reading it synchronously in `run_tts()` is safe for the same
    reason it's safe in MlxTTSService / OpenRouterTTSService: the pipeline
    processes one utterance at a time, so `last_direction` always belongs to
    the utterance currently being synthesized.
    """

    def __init__(
        self,
        *,
        tone_source: "Any | None" = None,
        default_voice: str = EDGE_TTS_DEFAULT_VOICE,
        **kwargs: Any,
    ) -> None:
        super().__init__(push_start_frame=True, push_stop_frames=True, **kwargs)
        self._tone_source = tone_source
        self._default_voice = default_voice

    def can_generate_metrics(self) -> bool:
        return True

    def _voice_for_current_direction(self) -> str:
        """Map last_direction → Edge TTS voice for the destination language."""
        if self._tone_source is None:
            return self._default_voice
        direction: str | None = getattr(self._tone_source, "last_direction", None)
        if not direction or "->" not in direction:
            return self._default_voice
        dst_code = direction.split("->", 1)[1].lower()
        return EDGE_TTS_VOICES.get(dst_code, self._default_voice)

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        voice = self._voice_for_current_direction()
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


def build_edge_tts(
    tone_source: "Any | None" = None,
    default_voice: str = EDGE_TTS_DEFAULT_VOICE,
) -> ToneAwareEdgeTTSService:
    """Construct the Edge TTS service for the cloud pipeline.

    `tone_source`: the pipeline's TranslationDirectionStripper, forwarded so
    the service can select the correct voice per utterance (ZH→EN gets an
    English voice, EN→ZH gets a Chinese voice).
    """
    return ToneAwareEdgeTTSService(
        tone_source=tone_source,
        default_voice=default_voice,
        settings=TTSSettings(model=None, voice=default_voice, language=None),
    )
