"""Pipecat pipeline for the real-time speech-to-speech translator.

Pipeline shape:

    transport.input() -> STT (Deepgram) -> [transcript tap] -> user aggregator
        -> LLM (Anthropic, translation-only prompt) -> [translation tap]
        -> TTS (Cartesia) -> transport.output() -> assistant aggregator

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
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from app.config import Settings

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


def build_pipeline(
    webrtc_connection: SmallWebRTCConnection, settings: Settings
) -> tuple[Pipeline, LLMContext]:
    """Construct the full translator pipeline for a single WebRTC connection.

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

    stt = DeepgramSTTService(api_key=settings.deepgram_api_key)

    tts = CartesiaTTSService(
        api_key=settings.cartesia_api_key,
        settings=CartesiaTTSService.Settings(voice=DEFAULT_CARTESIA_VOICE_ID),
    )

    system_prompt = build_translation_system_prompt(settings.source_lang, settings.target_lang)
    llm = AnthropicLLMService(
        api_key=settings.anthropic_api_key,
        settings=AnthropicLLMSettings(system_instruction=system_prompt),
    )

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
            llm,  # Translate (Anthropic)
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
