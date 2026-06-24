"""Pipecat pipeline for the real-time speech-to-speech translator.

Pipeline shape:

    transport.input() -> STT -> [transcript tap] -> user aggregator
        -> LLM (translation-only prompt) -> [translation tap]
        -> TTS -> transport.output() -> assistant aggregator

The STT/LLM/TTS services are either the cloud trio (Deepgram, Anthropic,
Cartesia) or the local/offline trio (Whisper via faster-whisper, Ollama, and
Piper -- see app/local_services.py), chosen once at pipeline-build time by
`should_use_local_services()` based on a startup connectivity check (or an
explicit `FORCE_OFFLINE`/`FORCE_ONLINE` override). The pipeline *shape* is
identical either way -- only the concrete service instances differ.

The LLM step is deliberately constrained to *translation only*: the system
prompt instructs it to detect the spoken language and translate it into the
configured target language, and to never answer questions, chat, or add
commentary. This is a translator, not a chatbot.

Direction is configured via `SOURCE_LANG`/`TARGET_LANG` (see app/config.py).
Full bidirectional auto-detection-with-swap and a UI toggle are out of scope
for this phase; what we do here is a reasonable middle ground: the prompt
asks the model to auto-detect the spoken language and always translate into
TARGET_LANG, falling back to SOURCE_LANG if speech already arrives in the
target language (so a stray utterance in the target language is passed
through/translated back into itself rather than mistranslated).
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import Frame, OutputTransportMessageUrgentFrame, TranscriptionFrame, TTSTextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.anthropic.llm import AnthropicLLMService, AnthropicLLMSettings
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.llm_service import LLMService
from pipecat.services.stt_service import STTService
from pipecat.services.tts_service import TTSService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from app.config import Settings
from app.connectivity import has_internet_connection
from app.local_services import build_local_llm, build_local_stt, build_local_tts

# Cartesia voice: "British Reading Lady", a stable default voice available on
# every Cartesia account. Override by editing this constant if you have a
# preferred voice_id.
DEFAULT_CARTESIA_VOICE_ID = "71a7ad14-091c-4e8e-a314-022ece01c121"


def build_translation_system_prompt(source_lang: str, target_lang: str) -> str:
    """Build the system prompt that constrains the LLM to translation-only behavior."""
    return (
        f"You are a real-time speech translation engine, not a conversational assistant. "
        f"You will receive a transcribed utterance, most likely spoken in {source_lang} "
        f"but possibly in {target_lang} or another language. "
        f"Your ONLY job is to translate the utterance into {target_lang}. "
        f"If the utterance is already in {target_lang}, translate it into {source_lang} instead. "
        f"Output ONLY the translated text and nothing else: "
        f"no greetings, no commentary, no explanations, no notes about the translation, "
        f"no quotation marks, and no answering of questions contained in the utterance. "
        f"Do not engage with the content of the message -- translate it verbatim in meaning. "
        f"If the utterance is empty, inaudible, or just noise, output nothing."
    )


class TranscriptTapProcessor(FrameProcessor):
    """Forwards transcription/translation text to the browser client as JSON
    over the WebRTC data channel, without altering the frame flow.

    Sits inline in the pipeline purely as an observer/tap: every frame it
    receives is pushed onward unchanged after optionally emitting a sibling
    `OutputTransportMessageUrgentFrame` carrying a small JSON payload that the
    client's data-channel handler renders into the transcript log.
    """

    def __init__(self, kind: str, **kwargs: Any) -> None:
        """Args:
        kind: "original" for source-language transcripts, "translation" for
            the LLM's translated text that's about to be spoken by TTS.
        """
        super().__init__(**kwargs)
        self._kind = kind

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        text: str | None = None
        if self._kind == "original" and isinstance(frame, TranscriptionFrame):
            text = frame.text
        elif self._kind == "translation" and isinstance(frame, TTSTextFrame):
            text = frame.text

        if text:
            payload = {"type": "transcript", "kind": self._kind, "text": text}
            await self.push_frame(
                OutputTransportMessageUrgentFrame(message=payload), direction
            )

        await self.push_frame(frame, direction)


def should_use_local_services(settings: Settings) -> bool:
    """Decide cloud vs. local services for this run, at startup only.

    Precedence:
    1. `FORCE_OFFLINE=true` -> always local (for testing without physically
       disconnecting the network).
    2. `FORCE_ONLINE=true` -> always cloud (for testing the cloud path even
       on a flaky connection, or to skip the connectivity probe).
    3. Otherwise, probe for a working internet connection
       (`app.connectivity.has_internet_connection`) and use local services
       if and only if that probe fails.

    This selection happens once, at pipeline-build time, for the lifetime of
    the connection. There is no mid-conversation re-checking or switching --
    that is explicitly out of scope for this phase.
    """
    if settings.force_offline:
        logger.info("FORCE_OFFLINE=true -- using local/offline services")
        return True
    if settings.force_online:
        logger.info("FORCE_ONLINE=true -- using cloud services")
        return False

    online = has_internet_connection()
    if online:
        logger.info("Internet connection detected -- using cloud services")
    else:
        logger.warning("No internet connection detected -- falling back to local/offline services")
    return not online


def _build_cloud_services(settings: Settings, system_prompt: str) -> tuple[STTService, LLMService, TTSService]:
    """Build the cloud STT/LLM/TTS service trio (Deepgram/Anthropic/Cartesia)."""
    stt = DeepgramSTTService(api_key=settings.deepgram_api_key)

    llm = AnthropicLLMService(
        api_key=settings.anthropic_api_key,
        settings=AnthropicLLMSettings(system_instruction=system_prompt),
    )

    tts = CartesiaTTSService(
        api_key=settings.cartesia_api_key,
        settings=CartesiaTTSService.Settings(voice=DEFAULT_CARTESIA_VOICE_ID),
    )

    return stt, llm, tts


def _build_local_service_trio(settings: Settings, system_prompt: str) -> tuple[STTService, LLMService, TTSService]:
    """Build the local/offline STT/LLM/TTS service trio (Whisper/Ollama/Piper)."""
    stt = build_local_stt(settings)
    llm = build_local_llm(settings, system_prompt)
    tts = build_local_tts(settings)
    return stt, llm, tts


def build_pipeline(
    webrtc_connection: SmallWebRTCConnection, settings: Settings
) -> tuple[Pipeline, LLMContext]:
    """Construct the full translator pipeline for a single WebRTC connection.

    Picks cloud vs. local STT/LLM/TTS services once, at build time, via
    `should_use_local_services()` -- see that function's docstring for the
    selection logic (connectivity probe + FORCE_OFFLINE/FORCE_ONLINE
    overrides). The pipeline *shape* is identical either way: only the
    concrete service instances differ.

    Returns the assembled `Pipeline` plus the `LLMContext` (handy for callers
    that want to seed/inspect conversation state, though this translator does
    not need turn-by-turn history -- each utterance is translated
    independently).
    """
    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )

    system_prompt = build_translation_system_prompt(settings.source_lang, settings.target_lang)

    if should_use_local_services(settings):
        stt, llm, tts = _build_local_service_trio(settings, system_prompt)
    else:
        stt, llm, tts = _build_cloud_services(settings, system_prompt)

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    original_tap = TranscriptTapProcessor(kind="original")
    translation_tap = TranscriptTapProcessor(kind="translation")

    pipeline = Pipeline(
        [
            transport.input(),  # Mic audio in
            stt,  # Speech -> text (source language)
            original_tap,  # Tap: forward original transcript to client
            user_aggregator,  # Build user turn for the LLM
            llm,  # Translate (Anthropic, or local Ollama model when offline)
            translation_tap,  # Tap: forward translated text to client
            tts,  # Translated text -> speech
            transport.output(),  # Speech audio out
            assistant_aggregator,  # Record assistant turn
        ]
    )

    return pipeline, context


def build_pipeline_worker(
    webrtc_connection: SmallWebRTCConnection, settings: Settings
) -> PipelineWorker:
    """Build the pipeline and wrap it in a `PipelineWorker` ready to run.

    Interruption/barge-in: Pipecat's pipeline + VAD analyzer combination
    handles this out of the box (the VAD on the transport input emits
    interruption frames when the user starts speaking again while the bot is
    talking, which cancels in-flight TTS/LLM work downstream). No custom
    interruption logic is implemented here -- that's intentionally left to
    Pipecat's defaults for this phase.
    """
    pipeline, _context = build_pipeline(webrtc_connection, settings)
    return PipelineWorker(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )
