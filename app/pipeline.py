"""Pipecat pipeline for the real-time speech-to-speech translator.

Pipeline shape:

    transport.input() -> STT -> [transcript tap] -> user aggregator
        -> LLM (bidirectional translation prompt) -> [direction stripper]
        -> TTS -> [translation tap] -> transport.output() -> assistant aggregator

The STT/LLM/TTS services are either the cloud trio (Deepgram, Anthropic,
Cartesia) or the local/offline trio (Whisper via faster-whisper, Ollama, and
Piper -- see app/local_services.py), chosen once at pipeline-build time by
`should_use_local_services()` based on a startup connectivity check (or an
explicit `FORCE_OFFLINE`/`FORCE_ONLINE` override). The pipeline *shape* is
identical either way -- only the concrete service instances differ.

The LLM step is deliberately constrained to *translation only*: the system
prompt instructs it to detect which of the two configured languages
(SOURCE_LANG/TARGET_LANG) the speaker just used, and to translate into
whichever of the two is the OTHER one. This is genuinely bidirectional/
symmetric -- there's no single "always translate into TARGET_LANG" fallback,
both directions are first-class. See `build_translation_system_prompt` for
how the model is asked to report which direction it picked (a `[XX->YY]`
prefix it emits before the translation, which `TranslationDirectionStripper`
parses and strips before the text reaches TTS).
"""

from __future__ import annotations

import re
from typing import Any

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    Frame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputTransportMessageUrgentFrame,
    TranscriptionFrame,
    TTSTextFrame,
)
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
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_start.transcription_user_turn_start_strategy import (
    TranscriptionUserTurnStartStrategy,
)
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from app.config import Settings
from app.connectivity import has_internet_connection
from app.local_services import build_local_llm, build_local_stt, build_local_tts

# Cartesia voice per TARGET_LANG, keyed by the *short* language code we parse
# out of SOURCE_LANG/TARGET_LANG (see `_lang_code`).
#
# Approach: Cartesia's multilingual Sonic models (sonic-3.5, used here --
# sonic-2/sonic-3/sonic-multilingual also qualify) render a *single* voice
# recording correctly across 40+ languages by adapting pronunciation to
# whatever the `language` field says, rather than requiring a distinct
# per-language voice clone (confirmed via Cartesia's docs/blog -- "the same
# voice can speak in different languages without needing separate voice
# recordings for each language"). This is what makes the per-language voice
# selection below tractable at all: we don't need N different voice_ids.
#
# We deliberately reuse ONE known-good voice_id (the "British Reading Lady"
# voice already used by the Phase 1 prototype, confirmed real/working on a
# live account) across every language below, rather than inventing distinct
# voice_ids per language: this codebase has no working Cartesia API key, so
# any other voice_id we might list here cannot be verified as real --
# shipping unverified made-up UUIDs would be worse than relying on the one
# ID known to work, paired with the correct `language` setting per
# `cartesia_language_for()` so Cartesia phonemizes/pronounces the text
# correctly even though the voice's own native recording is English.
# TODO(orchestrator, once a real CARTESIA_API_KEY exists): browse Cartesia's
# voice library (https://www.cartesia.ai/voices or the `/voices` list API,
# filtered by `language`) and swap in a voice actually recorded in each
# target language here for more natural accent/prosody -- this dict is the
# only thing that needs to change, see `cartesia_voice_for_language()`.
CARTESIA_VOICE_IDS: dict[str, str] = {
    # "British Reading Lady" -- the one voice_id verified to exist on a real
    # Cartesia account (carried over from the Phase 1 prototype). Reused for
    # every language below; only the `language` setting changes per
    # TARGET_LANG (see `_build_cloud_services`), relying on sonic-3.5's
    # multilingual rendering rather than a native-language voice recording.
    "en": "71a7ad14-091c-4e8e-a314-022ece01c121",
    "fr": "71a7ad14-091c-4e8e-a314-022ece01c121",
    "de": "71a7ad14-091c-4e8e-a314-022ece01c121",
    "es": "71a7ad14-091c-4e8e-a314-022ece01c121",
    "it": "71a7ad14-091c-4e8e-a314-022ece01c121",
}

# Maps the free-text language names accepted by SOURCE_LANG/TARGET_LANG (see
# app/config.py) to (a) the short code used to key CARTESIA_VOICE_IDS above
# and Pipecat's `Language` enum, and (b) the bracket tag the LLM is asked to
# use in its `[XX->YY]` direction prefix. Add an entry here to support a new
# TARGET_LANG value -- no other code changes needed.
_LANGUAGE_CODES: dict[str, str] = {
    "english": "en",
    "french": "fr",
    "français": "fr",
    "german": "de",
    "deutsch": "de",
    "spanish": "es",
    "español": "es",
    "italian": "it",
    "italiano": "it",
    "chinese": "zh",
    "mandarin": "zh",
    "中文": "zh",
}

_PIPECAT_LANGUAGE_BY_CODE: dict[str, Language] = {
    "en": Language.EN,
    "fr": Language.FR,
    "de": Language.DE,
    "es": Language.ES,
    "it": Language.IT,
    "zh": Language.ZH,
}

_DIRECTION_PREFIX_RE = re.compile(r"^\s*\[([A-Za-z]{2,3})\s*->\s*([A-Za-z]{2,3})\]\s*")


def _lang_code(lang_name: str) -> str:
    """Best-effort short code (e.g. "fr") for a free-text language name.

    Falls back to a lowercased/truncated form of the input itself if it's
    not in `_LANGUAGE_CODES`, so unrecognized SOURCE_LANG/TARGET_LANG values
    degrade gracefully (the LLM prompt and prefix-parsing logic are
    string-based and don't strictly require a known code; only Cartesia
    voice/language selection benefits from an exact match, where unrecognized
    codes fall back to the English voice -- see `cartesia_voice_for_language`
    below).
    """
    key = lang_name.strip().lower()
    return _LANGUAGE_CODES.get(key, key[:2] or "en")


def cartesia_voice_for_language(lang_name: str) -> str:
    """Pick a Cartesia voice_id appropriate for the given TARGET_LANG value.

    See the `CARTESIA_VOICE_IDS` module comment: every entry currently
    resolves to the same verified voice_id, relying on Cartesia's
    multilingual Sonic model (paired with `cartesia_language_for()` setting
    the correct `language`) rather than a native-language voice recording.
    Swap in real per-language voice_ids there once a Cartesia account/API key
    is available to browse the voice library. Falls back to the English
    entry if the language isn't in the map at all.
    """
    code = _lang_code(lang_name)
    return CARTESIA_VOICE_IDS.get(code, CARTESIA_VOICE_IDS["en"])


def cartesia_language_for(lang_name: str) -> Language:
    """Map a free-text TARGET_LANG/SOURCE_LANG value to Pipecat's `Language`
    enum, for Cartesia's `language` TTS setting. Falls back to English.
    """
    code = _lang_code(lang_name)
    return _PIPECAT_LANGUAGE_BY_CODE.get(code, Language.EN)


def build_translation_system_prompt(source_lang: str, target_lang: str) -> str:
    """Build the system prompt that constrains the LLM to bidirectional,
    translation-only behavior between exactly the two configured languages.

    The model is asked to auto-detect, per utterance, which of the two
    configured languages was spoken and to translate into the OTHER one --
    symmetric in both directions, not just a single fixed
    source-or-target/target-or-source fallback. To make the chosen direction
    legible to the rest of the pipeline (and ultimately to the browser UI),
    the model is asked to prefix its output with a small structured tag,
    `[XX->YY]`, using the short language codes below, followed by the
    translated text and nothing else. `TranslationDirectionStripper` (see
    below) parses and removes this prefix before the text reaches TTS.

    A tagged prefix (rather than e.g. Anthropic tool-call/structured output)
    is used because this needs to work identically across both the cloud
    Anthropic path and the local Ollama path (see app/local_services.py,
    which reuses this exact prompt) -- tool calls aren't a sensible fit for
    a small local instruct model used purely for one-shot translation, and
    keeping a single prompt-based mechanism for both paths avoids the cloud
    and local pipelines silently behaving differently.
    """
    source_code = _lang_code(source_lang).upper()
    target_code = _lang_code(target_lang).upper()
    return (
        f"You are a real-time bidirectional speech translation engine, not a "
        f"conversational assistant. Exactly two languages are in play: "
        f"{source_lang} (code {source_code}) and {target_lang} (code {target_code}). "
        f"You will receive a single transcribed utterance spoken in ONE of these "
        f"two languages -- you do not know in advance which one. "
        f"Step 1: detect which of the two configured languages the utterance is in. "
        f"Step 2: translate it into the OTHER configured language (if the utterance "
        f"is in {source_lang}, translate into {target_lang}; if it is in {target_lang}, "
        f"translate into {source_lang}). "
        f"Step 3: output a direction tag followed by the translation, in EXACTLY this "
        f"format and nothing else: `[SRC->DST] translated text`, where SRC and DST are "
        f"whichever of {source_code}/{target_code} you detected as source and "
        f"destination (e.g. `[{source_code}->{target_code}] ...` or "
        f"`[{target_code}->{source_code}] ...` depending on what you heard). "
        f"If the utterance is in neither configured language, detect its actual "
        f"language as best you can, translate into {target_lang}, and use that "
        f"language's own short code as SRC. "
        f"Output ONLY the tag and the translated text: no greetings, no commentary, "
        f"no explanations, no notes about the translation, no quotation marks, and no "
        f"answering of questions contained in the utterance. Do not engage with the "
        f"content of the message -- translate it verbatim in meaning. "
        f"If the utterance is empty, inaudible, or just noise, output nothing at all "
        f"(not even the tag)."
    )


def parse_direction_prefix(text: str) -> tuple[str | None, str]:
    """Parse a leading `[XX->YY]` direction tag off LLM output text.

    Returns `(direction, remaining_text)` where `direction` is the
    normalized `"XX->YY"` string (uppercased) if a tag was found, else
    `None`; `remaining_text` is `text` with the tag (and the whitespace
    immediately following it) removed. If no tag is found, `remaining_text`
    is `text` unchanged.
    """
    match = _DIRECTION_PREFIX_RE.match(text)
    if not match:
        return None, text
    direction = f"{match.group(1).upper()}->{match.group(2).upper()}"
    return direction, text[match.end():]


class TranslationDirectionStripper(FrameProcessor):
    """Sits between the translation LLM and TTS.

    Parses and strips the `[XX->YY]` direction prefix (see
    `build_translation_system_prompt`/`parse_direction_prefix`) off the
    LLM's text output before it reaches TTS -- the prefix is structured
    metadata for this pipeline, not something that should be spoken aloud.

    The parsed direction (e.g. "ZH->FR") is kept as instance state
    (`last_direction`) so that `TranscriptTapProcessor` (downstream, after
    TTS) can attach it to the transcript JSON message it sends to the
    browser. This relies on utterances being processed one at a time
    (no concurrent in-flight translations), which holds for this pipeline's
    shape -- each user turn produces one LLM response before the next one
    starts.
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.last_direction: str | None = None
        # Only the *first* text frame of a given LLM turn carries the
        # prefix (it's emitted once, at the start of the response); later
        # frames in the same turn are plain continuation text.
        self._awaiting_prefix = True

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMTextFrame):
            text = frame.text
            if self._awaiting_prefix:
                parsed_direction, text = parse_direction_prefix(text)
                if parsed_direction:
                    self.last_direction = parsed_direction
                if text:
                    self._awaiting_prefix = False
            if not text:
                # Prefix-only frame (the tag arrived in its own frame, with
                # no translated text yet) or a genuinely empty frame --
                # nothing left worth sending on to TTS. Drop it rather than
                # forwarding the original (unstripped) frame, which would
                # otherwise leak the "[XX->YY]" tag into speech.
                return
            frame = LLMTextFrame(text)
        elif isinstance(frame, LLMFullResponseStartFrame):
            # Reset for the next turn's response.
            self._awaiting_prefix = True

        await self.push_frame(frame, direction)


class TranscriptTapProcessor(FrameProcessor):
    """Forwards transcription/translation text to the browser client as JSON
    over the WebRTC data channel, without altering the frame flow.

    Sits inline in the pipeline purely as an observer/tap: every frame it
    receives is pushed onward unchanged after optionally emitting a sibling
    `OutputTransportMessageUrgentFrame` carrying a small JSON payload that the
    client's data-channel handler renders into the transcript log.

    The "translation" tap must sit *after* TTS in the pipeline, not before --
    `TTSTextFrame` is emitted by the TTS service itself once it has consumed
    the LLM's text (see `pipecat.services.tts_service`), so a tap positioned
    between the LLM and TTS would never see one.
    """

    def __init__(
        self,
        kind: str,
        direction_source: "TranslationDirectionStripper | None" = None,
        **kwargs: Any,
    ) -> None:
        """Args:
        kind: "original" for source-language transcripts, "translation" for
            the LLM's translated text that's about to be spoken by TTS.
        direction_source: for kind="translation", the `TranslationDirectionStripper`
            instance upstream in the pipeline whose `last_direction` (e.g.
            "ZH->FR") should be attached to each outgoing message as `direction`.
        """
        super().__init__(**kwargs)
        self._kind = kind
        self._direction_source = direction_source

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        text: str | None = None
        if self._kind == "original" and isinstance(frame, TranscriptionFrame):
            text = frame.text
        elif self._kind == "translation" and isinstance(frame, TTSTextFrame):
            text = frame.text

        if text:
            payload: dict[str, Any] = {"type": "transcript", "kind": self._kind, "text": text}
            if self._direction_source is not None:
                payload["direction"] = self._direction_source.last_direction
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
    """Build the cloud STT/LLM/TTS service trio (Deepgram/Anthropic/Cartesia).

    The Cartesia voice is picked per `settings.target_lang` (see
    `CARTESIA_VOICE_IDS`/`cartesia_voice_for_language`) -- a single
    hardcoded English voice would mispronounce/garble non-English
    TARGET_LANG values. The `language` setting is set the same way so
    Cartesia's multilingual Sonic model phonemizes the text correctly.
    """
    stt = DeepgramSTTService(api_key=settings.deepgram_api_key)

    llm = AnthropicLLMService(
        api_key=settings.anthropic_api_key,
        settings=AnthropicLLMSettings(system_instruction=system_prompt),
    )

    tts = CartesiaTTSService(
        api_key=settings.cartesia_api_key,
        settings=CartesiaTTSService.Settings(
            model="sonic-3.5",
            voice=cartesia_voice_for_language(settings.target_lang),
            language=cartesia_language_for(settings.target_lang),
        ),
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

    # Barge-in/interruption: explicitly constructed (rather than relying on
    # library defaults) with `enable_interruptions=True` on both user-turn
    # start strategies, so that the user speaking again while the bot is
    # talking reliably emits an interruption frame that cancels in-flight
    # LLM/TTS work -- VAD covers the common case, transcription is a
    # fallback for soft speech VAD might miss.
    user_turn_strategies = UserTurnStrategies(
        start=[
            VADUserTurnStartStrategy(enable_interruptions=True),
            TranscriptionUserTurnStartStrategy(enable_interruptions=True),
        ],
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
            user_turn_strategies=user_turn_strategies,
        ),
    )

    direction_stripper = TranslationDirectionStripper()
    original_tap = TranscriptTapProcessor(kind="original")
    translation_tap = TranscriptTapProcessor(kind="translation", direction_source=direction_stripper)

    pipeline = Pipeline(
        [
            transport.input(),  # Mic audio in
            stt,  # Speech -> text (source language)
            original_tap,  # Tap: forward original transcript to client
            user_aggregator,  # Build user turn for the LLM
            llm,  # Translate (Anthropic, or local Ollama model when offline)
            direction_stripper,  # Parse+strip the "[XX->YY]" direction prefix
            tts,  # Translated text -> speech
            translation_tap,  # Tap: forward translated text + direction to client
            transport.output(),  # Speech audio out
            assistant_aggregator,  # Record assistant turn
        ]
    )

    return pipeline, context


def build_pipeline_worker(
    webrtc_connection: SmallWebRTCConnection, settings: Settings
) -> PipelineWorker:
    """Build the pipeline and wrap it in a `PipelineWorker` ready to run.

    Interruption/barge-in: explicitly configured in `build_pipeline()` via
    `UserTurnStrategies(start=[VADUserTurnStartStrategy(enable_interruptions=True),
    TranscriptionUserTurnStartStrategy(enable_interruptions=True)])` passed to
    `LLMUserAggregatorParams.user_turn_strategies`. This *happens* to match
    Pipecat 1.4's own defaults (both default start strategies already set
    `enable_interruptions=True`), but it's spelled out explicitly here rather
    than left implicit, since an unverified assumption that "interruption
    comes for free" is exactly what this constructed-but-never-tested-with-
    real-audio pipeline needs to not repeat. Verifying actual barge-in
    behavior under live audio (does the bot's TTS audibly stop when the user
    starts talking over it) still requires real API keys/mic and is left for
    the orchestrator.
    """
    pipeline, _context = build_pipeline(webrtc_connection, settings)
    return PipelineWorker(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )
