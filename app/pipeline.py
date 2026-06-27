"""Pipecat pipeline for the real-time speech-to-speech translator.

Pipeline shape:

    transport.input() -> STT -> [transcript tap] -> user aggregator
        -> LLM (bidirectional translation prompt) -> [direction stripper]
        -> TTS -> [translation tap] -> transport.output() -> assistant aggregator

The STT/LLM/TTS services are one of three trios, chosen once at
pipeline-build time by `select_engine()`:

- "cloud": Deepgram + Anthropic + Cartesia.
- "offline": Whisper (faster-whisper) + Ollama + Piper -- see
  app/local_services.py. The Raspberry Pi-portable fallback.
- "omlx": a local oMLX server (OpenAI-API-compatible) -- see
  app/mlx_services.py. Mac-only (Apple Silicon/MLX), dev/test only, never
  auto-selected -- NOT Pi-portable.

`ENGINE` (env var: "auto"/"cloud"/"offline"/"omlx", default "auto")
controls this; "auto" reproduces the original behavior of probing for
internet connectivity at pipeline-build time and picking cloud vs. offline
accordingly (the legacy `FORCE_OFFLINE`/`FORCE_ONLINE` booleans still work,
mapped internally to `ENGINE=offline`/`ENGINE=cloud` -- see
app/config.py's `_resolve_engine`). The pipeline *shape* is identical
across all three -- only the concrete service instances differ.

The LLM step is deliberately constrained to *translation only*: the system
prompt instructs it to detect which of the two configured languages
(SOURCE_LANG/TARGET_LANG) the speaker just used, and to translate into
whichever of the two is the OTHER one. This is genuinely bidirectional/
symmetric -- there's no single "always translate into TARGET_LANG" fallback,
both directions are first-class. See `build_translation_system_prompt` for
how the model is asked to report which direction it picked plus a short
tone/register hint (a `[XX->YY|tone]` prefix it emits before the
translation, which `TranslationDirectionStripper` parses and strips before
the text reaches TTS).

Despite an earlier Phase-1 docstring claiming this translator doesn't need
turn-by-turn history, it now genuinely does: the LLM is given recent
conversation history (bounded to `MAX_CONTEXT_TURNS` turns -- see
`_trim_context_to_recent_turns`) and is instructed to use it to (a) silently
resolve obvious ASR mishearings/typos that don't fit the conversation
(verified live: a small local model, given the prior turn's bathroom-related
context, correctly inferred a homophone-garbled "西首肩" was probably "西边"
("west side"); without the corrected prompt it narrated that inference out
loud instead of applying it silently) and (b) infer a tone/register hint
from phrasing + conversation flow, carried in the `|tone` segment of the tag
and ultimately passed to TTS as an expressiveness hint (see
`MlxTTSService.run_tts` in app/mlx_services.py).
"""

from __future__ import annotations

import re
from collections.abc import AsyncGenerator
from typing import Any

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
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
from pipecat.services.cartesia.tts import CartesiaEmotion, CartesiaTTSService
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

from app.config import CLOUD_REQUIRED_KEYS, Settings
from app.connectivity import has_internet_connection
from app.local_services import build_local_llm, build_local_stt, build_local_tts
from app.mlx_services import build_mlx_llm, build_mlx_stt, build_mlx_tts
from app.model_settings import ModelSettings, load_model_settings

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

# Like `_DIRECTION_PREFIX_RE`, but for the extended `[XX->YY|tone]` form that
# also carries a short free-text tone/register hint (see
# `build_translation_system_prompt`). Tries this first in
# `parse_direction_prefix`; falls back to the plain form for models that omit
# the tone segment (e.g. if a model ever ignores that part of the prompt).
_DIRECTION_TONE_PREFIX_RE = re.compile(
    r"^\s*\[([A-Za-z]{2,3})\s*->\s*([A-Za-z]{2,3})\s*\|\s*([^\]]*)\]\s*"
)

# Number of most-recent conversation turns (1 user + 1 assistant message each)
# kept in `LLMContext` -- see `_trim_context_to_recent_turns`. Bounds latency/
# context size for long-running sessions while still giving the LLM enough
# recent history to resolve ASR mishearings via context (the product owner's
# explicit ask -- see module docstring). 8 turns is a few dozen seconds of
# conversation at typical utterance length; generous enough for context-based
# correction, small enough to keep per-call latency in check on local models.
MAX_CONTEXT_TURNS = 8

# Default persona/behavior prose for the translation LLM -- the part
# `Settings.llm.system_prompt_override` (app/model_settings.py, the Model
# Lab feature) can replace. See `build_translation_system_prompt`'s
# docstring for the persona/format-contract split this exists to support.
_DEFAULT_PERSONA = (
    "You are a real-time bidirectional speech translation engine, not a "
    "conversational assistant. "
    "If the utterance, read literally, contains an obvious mishearing or "
    "typo that doesn't fit the conversation (this is speech-to-text output, "
    "not text a human typed -- expect homophone confusions, especially in "
    "Mandarin, e.g. 间/兼-style near-homophones), use the conversation "
    "context to silently infer the speaker's actual intended meaning and "
    "translate THAT. Never mention that a correction happened, never hedge, "
    "never explain your reasoning, never ask for clarification -- output "
    "only the translation of what you believe was actually meant, exactly "
    "as if the utterance had been transcribed correctly. If the utterance "
    "is unambiguous, just translate it normally. "
    "Do not engage with the content of the message -- translate it verbatim "
    "in meaning (after silent correction, if any), and do not answer "
    "questions contained in the utterance."
)


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


def build_translation_system_prompt(
    source_lang: str, target_lang: str, *, persona_override: str | None = None
) -> str:
    """Build the system prompt that constrains the LLM to bidirectional,
    translation-only behavior between exactly the two configured languages.

    The model is asked to auto-detect, per utterance, which of the two
    configured languages was spoken and to translate into the OTHER one --
    symmetric in both directions, not just a single fixed
    source-or-target/target-or-source fallback. To make the chosen direction
    legible to the rest of the pipeline (and ultimately to the browser UI),
    the model is asked to prefix its output with a small structured tag,
    `[XX->YY|tone]`, using the short language codes below plus a short
    free-text tone/register hint, followed by the translated text and
    nothing else. `TranslationDirectionStripper` (see below) parses and
    removes this prefix before the text reaches TTS, exposing both the
    direction and the tone hint to downstream consumers (the transcript tap
    and the TTS services' tone-to-expressiveness wiring -- see
    `MlxTTSService.run_tts` in app/mlx_services.py and the Cartesia wrapper in
    `_build_cloud_services`).

    A tagged prefix (rather than e.g. Anthropic tool-call/structured output)
    is used because this needs to work identically across both the cloud
    Anthropic path and the local Ollama path (see app/local_services.py,
    which reuses this exact prompt) -- tool calls aren't a sensible fit for
    a small local instruct model used purely for one-shot translation, and
    keeping a single prompt-based mechanism for both paths avoids the cloud
    and local pipelines silently behaving differently.

    Two behaviors the product owner explicitly asked for, beyond bare
    translation:

    - Context-aware silent correction: the model is given recent
      conversation history (see `MAX_CONTEXT_TURNS`/`build_pipeline`) and is
      told to use it to silently resolve obvious ASR mishearings (e.g.
      Mandarin homophone confusions) rather than translating a garbled
      transcript literally -- and to never mention having done so. Verified
      live (this session) that without this instruction, a small local model
      asked to translate a homophone-garbled utterance right after an
      on-topic previous turn will reason about the likely correction *out
      loud*, as extra translated sentences (e.g. "(Notice: ... appears to be
      a typo ...)") -- proving the context is already sufficient for the
      correction, but leaking it as visible commentary instead of applying
      it silently. This instruction targets exactly that leak.
    - Tone/register inference: ASR strips all prosody, but the model can
      infer register/emotion/urgency from phrasing and conversation flow.
      The model is asked to report a short tone descriptor in the tag so
      TTS can render something other than a flat, robotic affect.

    `persona_override` (the Model Lab feature, see app/model_settings.py):
    this prompt is two conceptually distinct pieces glued together --
    PERSONA prose (who the model is, how it should behave/correct/infer
    tone -- see `_DEFAULT_PERSONA` below) and a FORMAT CONTRACT (the exact
    `[SRC->DST|tone]` tag mechanics the rest of the pipeline structurally
    depends on -- `TranslationDirectionStripper`/`parse_direction_prefix`
    parse against that exact shape). When `persona_override` is a non-empty
    string, it REPLACES `_DEFAULT_PERSONA` only; the format contract is
    always appended verbatim regardless, since the pipeline cannot function
    without it (no tag -> no direction/tone routing -> TTS never gets
    triggered correctly). This is what makes "this product can become any
    persona" (the product owner's framing) safe to expose as a raw textarea
    in the client: a user can turn the translator into a pirate, a
    deadpan-formal interpreter, whatever -- the underlying tag protocol
    still gets emitted because it's not part of what they're editing.
    """
    source_code = _lang_code(source_lang).upper()
    target_code = _lang_code(target_lang).upper()
    persona = (persona_override or "").strip() or _DEFAULT_PERSONA
    format_contract = (
        f"Exactly two languages are in play: {source_lang} (code {source_code}) "
        f"and {target_lang} (code {target_code}). You will receive a single "
        f"transcribed utterance spoken in ONE of these two languages -- you do "
        f"not know in advance which one. You also receive the recent "
        f"conversation history (your own prior translations included) -- use it "
        f"as context. "
        f"Step 1: detect which of the two configured languages the utterance is in. "
        f"Step 2: translate into the OTHER configured language (if the utterance "
        f"is in {source_lang}, translate into {target_lang}; if it is in {target_lang}, "
        f"translate into {source_lang}). "
        f"Step 3: infer the speaker's tone/register/emotional intensity from their "
        f"phrasing and the conversation so far (e.g. \"neutral\", \"polite and a "
        f"little urgent\", \"casual, joking\", \"frustrated\", \"excited\") -- a "
        f"few words, in English, regardless of the configured languages. "
        f"Step 4: output a tag followed by the translation, in EXACTLY this format "
        f"and nothing else: `[SRC->DST|tone] translated text`, where SRC and DST are "
        f"whichever of {source_code}/{target_code} you detected as source and "
        f"destination (e.g. `[{source_code}->{target_code}|tone] ...` or "
        f"`[{target_code}->{source_code}|tone] ...` depending on what you heard), and "
        f"tone is your short tone descriptor from Step 3. "
        f"If the utterance is in neither configured language, detect its actual "
        f"language as best you can, translate into {target_lang}, and use that "
        f"language's own short code as SRC. "
        f"Output ONLY the tag and the translated text: no greetings, no commentary, "
        f"no explanations, no notes about the translation or about any correction "
        f"you made, no quotation marks, and no answering of questions contained in "
        f"the utterance. "
        f"If the utterance is empty, inaudible, or just noise, output nothing at all "
        f"(not even the tag)."
    )
    return f"{persona} {format_contract}"


def parse_direction_prefix(text: str) -> tuple[str | None, str | None, str]:
    """Parse a leading `[XX->YY|tone]` (or plain `[XX->YY]`) tag off LLM
    output text.

    Tries the tone-carrying form first (see `_DIRECTION_TONE_PREFIX_RE`),
    falling back to the plain form (`_DIRECTION_PREFIX_RE`) for models that
    omit the tone segment despite the prompt asking for it -- the rest of
    the pipeline should degrade gracefully (no tone hint) rather than fail
    to strip the tag at all.

    Returns `(direction, tone, remaining_text)`:
    - `direction`: the normalized `"XX->YY"` string (uppercased), or `None`
      if no tag was found at all.
    - `tone`: the free-text tone descriptor (stripped, as-is casing), or
      `None` if no tag was found, or the tag didn't carry a tone segment.
    - `remaining_text`: `text` with the tag (and the whitespace immediately
      following it) removed. Unchanged if no tag was found.
    """
    match = _DIRECTION_TONE_PREFIX_RE.match(text)
    if match:
        direction = f"{match.group(1).upper()}->{match.group(2).upper()}"
        tone = match.group(3).strip() or None
        return direction, tone, text[match.end():]

    match = _DIRECTION_PREFIX_RE.match(text)
    if not match:
        return None, None, text
    direction = f"{match.group(1).upper()}->{match.group(2).upper()}"
    return direction, None, text[match.end():]


class TranslationDirectionStripper(FrameProcessor):
    """Sits between the translation LLM and TTS.

    Parses and strips the `[XX->YY|tone]` direction+tone prefix (see
    `build_translation_system_prompt`/`parse_direction_prefix`) off the
    LLM's text output before it reaches TTS -- the prefix is structured
    metadata for this pipeline, not something that should be spoken aloud.

    The parsed direction (e.g. "ZH->FR") and tone hint (e.g. "polite and a
    little urgent") are kept as instance state (`last_direction`/
    `last_tone`) so that downstream consumers can read them synchronously:
    `TranscriptTapProcessor` (after TTS) attaches `last_direction` to the
    transcript JSON message sent to the browser, and the TTS services
    (`MlxTTSService` in app/mlx_services.py, and the Cartesia wrapper built
    in `_build_cloud_services`) read `last_tone` at `run_tts()` time to
    drive expressiveness. This relies on utterances being processed one at a
    time (no concurrent in-flight translations), which holds for this
    pipeline's shape -- each user turn produces one LLM response before the
    next one starts.
    """

    # Safety cap (characters) on how much text to buffer while waiting for
    # a tag's closing "]" before giving up and treating the buffered text as
    # tag-less (see `_awaiting_prefix`/`_prefix_buffer` below). Comfortably
    # larger than any real tag (`[XX->YY|tone]` -- worst case maybe ~40
    # chars for a verbose tone descriptor), so this only kicks in for a
    # genuinely tagless response, not a real tag split across frames.
    _MAX_PREFIX_BUFFER = 80

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.last_direction: str | None = None
        self.last_tone: str | None = None
        # Only the *first* text of a given LLM turn carries the prefix (it's
        # emitted once, at the start of the response); later text in the
        # same turn is plain continuation text. While awaiting the prefix,
        # incoming `LLMTextFrame` text is buffered (not forwarded) until
        # either a complete tag has been parsed off the front of the buffer,
        # or the buffer exceeds `_MAX_PREFIX_BUFFER` with no closing "]" in
        # sight (treated as "no tag at all" -- forward the buffer as-is).
        # This matters because the model streams its response in arbitrary
        # token-sized `LLMTextFrame` chunks: a short tag (`[XX->YY]`) tends
        # to land whole in the first chunk, but the longer tone-carrying tag
        # (`[XX->YY|tone]`) was observed live (this session) arriving split
        # across multiple chunks -- a non-buffering parse-attempt-per-frame
        # approach treated each unmatched partial chunk as "no tag here,
        # forward it" and leaked the raw `[ZH->EN|polite] Hello.` text
        # (tag and all) into TTS instead of stripping it.
        self._awaiting_prefix = True
        self._prefix_buffer = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMTextFrame):
            if not self._awaiting_prefix:
                await self.push_frame(frame, direction)
                return

            self._prefix_buffer += frame.text
            parsed_direction, parsed_tone, remaining = parse_direction_prefix(self._prefix_buffer)

            if parsed_direction is None and "]" not in self._prefix_buffer:
                if len(self._prefix_buffer) < self._MAX_PREFIX_BUFFER:
                    # Tag (if any) isn't fully buffered yet -- wait for more
                    # text before deciding. Drop this frame; its text is
                    # retained in `_prefix_buffer` and will be re-emitted
                    # (with or without a tag) once we can tell which.
                    return
                # No closing "]" within a generous budget -- conclude there
                # never was a tag (e.g. an empty/garbled response) and flush
                # the buffer through untouched rather than holding text
                # forever.
                remaining = self._prefix_buffer

            if parsed_direction:
                self.last_direction = parsed_direction
                self.last_tone = parsed_tone

            self._awaiting_prefix = False
            self._prefix_buffer = ""
            if not remaining:
                # Tag-only buffer (no translated text after it yet) --
                # nothing left worth sending on to TTS this frame. The next
                # LLMTextFrame (now with _awaiting_prefix=False) will carry
                # the actual translated text.
                return
            await self.push_frame(LLMTextFrame(remaining), direction)
            return
        elif isinstance(frame, LLMFullResponseStartFrame):
            # Reset for the next turn's response.
            self._awaiting_prefix = True
            self._prefix_buffer = ""
        elif isinstance(frame, LLMFullResponseEndFrame) and self._prefix_buffer:
            # The full response ended while still buffering (e.g. a short,
            # tagless response that never hit a "]" or the size cap above) --
            # flush whatever was buffered as plain text rather than silently
            # dropping it. No tag was found, so last_direction/last_tone are
            # left at their previous values (best-effort stale info is
            # better than resetting to None mid-conversation).
            buffered = self._prefix_buffer
            self._prefix_buffer = ""
            self._awaiting_prefix = False
            await self.push_frame(LLMTextFrame(buffered), direction)

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
                payload["tone"] = self._direction_source.last_tone
            await self.push_frame(
                OutputTransportMessageUrgentFrame(message=payload), direction
            )

        await self.push_frame(frame, direction)


def select_engine(settings: Settings) -> str:
    """Decide which engine ("cloud", "offline", or "omlx") to use for this
    run, at startup only.

    `settings.engine` is one of `app.config.VALID_ENGINES`
    ("auto"/"cloud"/"offline"/"omlx"), already resolved from `ENGINE` (or
    the legacy `FORCE_OFFLINE`/`FORCE_ONLINE` booleans) by
    `app.config.load_settings()`. "cloud"/"offline"/"omlx" are returned
    as-is; "auto" probes for a working internet connection
    (`app.connectivity.has_internet_connection`) and resolves to "offline"
    if and only if that probe fails, otherwise "cloud" -- this reproduces
    the original auto-detect behavior. "omlx" is never auto-selected: it
    must be requested explicitly via `ENGINE=omlx`, since it depends on a
    local oMLX server that isn't assumed to be running.

    This selection happens once, at pipeline-build time, for the lifetime of
    the connection. There is no mid-conversation re-checking or switching --
    that is explicitly out of scope for this phase.
    """
    if settings.engine != "auto":
        logger.info(f"ENGINE={settings.engine} -- using {settings.engine} services")
        return settings.engine

    online = has_internet_connection()
    if online:
        logger.info("Internet connection detected -- using cloud services")
        return "cloud"
    else:
        logger.warning("No internet connection detected -- falling back to local/offline services")
        return "offline"


# Best-effort mapping from the LLM's short free-text tone descriptor (see
# `build_translation_system_prompt`'s Step 4 -- things like "neutral",
# "polite and a little urgent", "casual, joking", "frustrated", "excited")
# to the nearest `CartesiaEmotion` value, for `ToneAwareCartesiaTTSService`
# below. Matching is substring-based on the free-text tone against these
# keys (see `_nearest_cartesia_emotion`) -- the LLM doesn't pick from this
# list directly (its prompt has no knowledge of Cartesia's emotion vocabulary
# at all, deliberately, so the same prompt/tag format works unchanged across
# the oMLX and Cartesia TTS backends), so this is a heuristic nearest-match,
# not an exact enum lookup.
#
# TODO(orchestrator, once a real CARTESIA_API_KEY exists): this entire
# mapping table, and `ToneAwareCartesiaTTSService` itself, are UNVERIFIED --
# there is no working Cartesia account in this environment to test against
# (same situation as `CARTESIA_VOICE_IDS` above). The `EMOTION_TAG()` helper
# and the emotion tag's actual effect on Cartesia's audio output have not
# been confirmed live the way the oMLX `instructions` field was (see
# `MlxTTSService.run_tts` in app/mlx_services.py, which *was* verified live
# this session). Re-verify the mapping quality and the tag's actual audible
# effect against a real account before trusting this in production.
_TONE_TO_CARTESIA_EMOTION: dict[str, CartesiaEmotion] = {
    "neutral": CartesiaEmotion.NEUTRAL,
    "calm": CartesiaEmotion.CALM,
    "urgent": CartesiaEmotion.ANXIOUS,
    "worried": CartesiaEmotion.ANXIOUS,
    "anxious": CartesiaEmotion.ANXIOUS,
    "polite": CartesiaEmotion.CONTENT,
    "friendly": CartesiaEmotion.CONTENT,
    "casual": CartesiaEmotion.CONTENT,
    "joking": CartesiaEmotion.JOKING_COMEDIC,
    "comedic": CartesiaEmotion.JOKING_COMEDIC,
    "excited": CartesiaEmotion.EXCITED,
    "happy": CartesiaEmotion.HAPPY,
    "enthusiastic": CartesiaEmotion.ENTHUSIASTIC,
    "frustrated": CartesiaEmotion.FRUSTRATED,
    "angry": CartesiaEmotion.ANGRY,
    "mad": CartesiaEmotion.MAD,
    "sad": CartesiaEmotion.SAD,
    "disappointed": CartesiaEmotion.DISAPPOINTED,
    "apologetic": CartesiaEmotion.APOLOGETIC,
    "confused": CartesiaEmotion.CONFUSED,
    "curious": CartesiaEmotion.CURIOUS,
    "surprised": CartesiaEmotion.SURPRISED,
    "amazed": CartesiaEmotion.AMAZED,
    "grateful": CartesiaEmotion.GRATEFUL,
    "confident": CartesiaEmotion.CONFIDENT,
    "hesitant": CartesiaEmotion.HESITANT,
    "sarcastic": CartesiaEmotion.SARCASTIC,
}


def _nearest_cartesia_emotion(tone: str | None) -> CartesiaEmotion | None:
    """Best-effort match of a free-text tone descriptor to a `CartesiaEmotion`.

    Substring match against `_TONE_TO_CARTESIA_EMOTION`'s keys (case
    -insensitive) -- the LLM's tone descriptor is free text (e.g. "polite
    and a little urgent"), not a value drawn from this table, so an exact
    dict lookup would almost never hit. Returns `None` if `tone` is `None`/
    empty or no key matches, in which case the caller should skip emitting
    an emotion tag entirely rather than guess.

    See the TODO on `_TONE_TO_CARTESIA_EMOTION` above -- this matching
    heuristic is unverified against a real Cartesia account.
    """
    if not tone:
        return None
    tone_lower = tone.lower()
    for keyword, emotion in _TONE_TO_CARTESIA_EMOTION.items():
        if keyword in tone_lower:
            return emotion
    return None


class ToneAwareCartesiaTTSService(CartesiaTTSService):
    """`CartesiaTTSService` subclass that prepends a per-utterance
    `<emotion>` tag derived from the translation LLM's inferred tone hint
    (see `TranslationDirectionStripper.last_tone`).

    Why a subclass instead of a constructor-time setting: Cartesia's emotion
    control is a *per-utterance* inline SSML-like tag
    (`CartesiaTTSService.EMOTION_TAG()`, e.g. `<emotion value="excited" />`),
    not something configurable once at construction time the way
    `CartesiaTTSService.Settings.emotion` (also per-utterance under the
    hood, just defaulted at the settings level) might suggest -- this
    pipeline needs a *different* emotion per utterance, following the
    LLM's own per-utterance tone inference, which means intercepting
    `run_tts()` and prepending the tag to the text actually sent, mirroring
    how `MlxTTSService`/`MlxSTTService` (app/mlx_services.py) are subclasses
    for analogous "need to do something the base class's settings can't
    express" reasons.

    Same pattern as `MlxTTSService` reading `TranslationDirectionStripper.
    last_tone` synchronously: safe because the pipeline's documented
    invariant is that utterances are processed one at a time (no concurrent
    in-flight translations), so `last_tone` is always the tone for the
    utterance currently being synthesized.

    UNVERIFIED end-to-end (no real Cartesia API key in this environment --
    see the TODO on `_TONE_TO_CARTESIA_EMOTION` above). Construction-only
    tested (this class instantiates and `_build_cloud_services` builds
    without error against a dummy API key).
    """

    def __init__(self, *, tone_source: "TranslationDirectionStripper", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._tone_source = tone_source

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        emotion = _nearest_cartesia_emotion(self._tone_source.last_tone)
        if emotion is not None:
            text = f"{self.EMOTION_TAG(emotion)} {text}"
        async for frame in super().run_tts(text, context_id):
            yield frame


def _build_cloud_services(
    settings: Settings,
    system_prompt: str,
    direction_stripper: "TranslationDirectionStripper",
    model_settings: ModelSettings,
) -> tuple[STTService, LLMService, TTSService]:
    """Build the cloud STT/LLM/TTS service trio (Deepgram/Anthropic/Cartesia).

    Validates that all three cloud API keys (`CLOUD_REQUIRED_KEYS`) are
    present -- deferred from `app.config.load_settings()` to exactly this
    point, since these keys are only actually required once the cloud
    engine path is selected and about to be built (see app/config.py's
    module docstring for why settings load no longer validates them
    eagerly).

    The Cartesia voice is picked per `settings.target_lang` (see
    `CARTESIA_VOICE_IDS`/`cartesia_voice_for_language`) by default, or
    overridden by `model_settings.tts.voice` (the Model Lab feature -- see
    app/model_settings.py) when set. The `language` setting is set per
    `settings.target_lang` regardless, so Cartesia's multilingual Sonic
    model phonemizes the text correctly even with a custom voice_id.

    `direction_stripper` is passed to `ToneAwareCartesiaTTSService` (see its
    docstring -- UNVERIFIED end-to-end, no real Cartesia account here) so
    the tone hint parsed out of the LLM's `[XX->YY|tone]` tag can flow into
    Cartesia's per-utterance emotion tag; `model_settings.tts.
    instructions_template` (an emotion-preset name in the cloud schema) is
    the static fallback `ToneAwareCartesiaTTSService` would need to use when
    no live tone is available yet -- NOT wired up here (see
    `ToneAwareCartesiaTTSService`'s own UNVERIFIED status; adding an
    untested fallback path on top of an already-untested mechanism isn't
    worth the risk until there's a real account to verify against).
    `model_settings.llm.temperature/top_p` flow into `AnthropicLLMSettings`.

    Raises:
        RuntimeError: if any of `CLOUD_REQUIRED_KEYS` is missing.
    """
    missing = [
        key
        for key in CLOUD_REQUIRED_KEYS
        if not getattr(settings, key.lower(), None)
    ]
    if missing:
        raise RuntimeError(
            "Cloud engine selected, but missing required environment "
            f"variable(s): {', '.join(missing)}. Copy .env.example to .env "
            "and fill in the missing API key(s), export them in your shell, "
            "or set ENGINE=offline/omlx to use a non-cloud engine instead."
        )

    # DeepgramSTTService's own default (when no `settings=` is given at all)
    # hardcodes `language=Language.EN` -- a pre-existing Phase-1 behavior
    # this change doesn't alter for the unhinted case (no real Deepgram key
    # in this environment to verify changing it is safe). Only applies an
    # explicit override when `language_hint` parses to a real `Language`.
    stt_kwargs: dict[str, object] = {}
    stt_language_hint = model_settings.stt.language_hint
    if stt_language_hint:
        try:
            stt_kwargs["settings"] = DeepgramSTTService.Settings(
                language=Language(stt_language_hint.strip().lower())
            )
        except ValueError:
            pass
    stt = DeepgramSTTService(api_key=settings.deepgram_api_key, **stt_kwargs)

    llm_overrides: dict[str, float] = {}
    if model_settings.llm.temperature is not None:
        llm_overrides["temperature"] = model_settings.llm.temperature
    if model_settings.llm.top_p is not None:
        llm_overrides["top_p"] = model_settings.llm.top_p
    llm = AnthropicLLMService(
        api_key=settings.anthropic_api_key,
        settings=AnthropicLLMSettings(system_instruction=system_prompt, **llm_overrides),
    )

    tts_overrides: dict[str, float] = {}
    if model_settings.tts.speed is not None:
        tts_overrides["speed"] = model_settings.tts.speed
    tts = ToneAwareCartesiaTTSService(
        tone_source=direction_stripper,
        api_key=settings.cartesia_api_key,
        settings=CartesiaTTSService.Settings(
            model="sonic-3.5",
            voice=model_settings.tts.voice or cartesia_voice_for_language(settings.target_lang),
            language=cartesia_language_for(settings.target_lang),
            **tts_overrides,
        ),
    )

    return stt, llm, tts


def _build_local_service_trio(
    settings: Settings, system_prompt: str, model_settings: ModelSettings
) -> tuple[STTService, LLMService, TTSService]:
    """Build the local/offline STT/LLM/TTS service trio (Whisper/Ollama/Piper).

    Only `llm`/`stt` Model Lab fields are wired here (see
    `app.local_services.build_local_llm`/`build_local_stt`) -- there's no
    `tts` section for this engine in `model_settings_schema()` at all
    (Piper has no expressiveness controls; see `build_local_tts`'s
    docstring for why that's a deliberate no-op, not an oversight).
    """
    stt = build_local_stt(settings, language_hint=model_settings.stt.language_hint)
    llm = build_local_llm(
        settings,
        system_prompt,
        temperature=model_settings.llm.temperature,
        top_p=model_settings.llm.top_p,
    )
    tts = build_local_tts(settings)
    return stt, llm, tts


def _build_mlx_service_trio(
    settings: Settings,
    system_prompt: str,
    direction_stripper: "TranslationDirectionStripper",
    model_settings: ModelSettings,
) -> tuple[STTService, LLMService, TTSService]:
    """Build the oMLX STT/LLM/TTS service trio (see app/mlx_services.py).

    Mac-only dev/test engine, NOT Pi-portable (depends on Apple's MLX
    framework). Requires a local oMLX server already running at
    `settings.omlx_base_url` with the three configured models loaded.

    `direction_stripper` is passed through to `build_mlx_tts` so
    `MlxTTSService.run_tts` can read `direction_stripper.last_tone`
    synchronously and forward it as the `instructions` field on oMLX's
    `/v1/audio/speech` -- verified live (this session) that this field
    measurably changes the generated audio for identical input text.

    `model_settings` (Model Lab overrides) flow into all three builders --
    this is the one engine where every field in `ModelSettings` has been
    live-verified to actually reach oMLX (the only engine with a real
    server to test against in this environment).
    """
    stt = build_mlx_stt(settings, language_hint=model_settings.stt.language_hint)
    llm = build_mlx_llm(
        settings,
        system_prompt,
        temperature=model_settings.llm.temperature,
        top_p=model_settings.llm.top_p,
    )
    tts = build_mlx_tts(
        settings,
        direction_stripper,
        voice=model_settings.tts.voice,
        default_instructions=model_settings.tts.instructions_template,
        speed=model_settings.tts.speed,
        temperature=model_settings.tts.temperature,
        top_p=model_settings.tts.top_p,
    )
    return stt, llm, tts


def _trim_context_to_recent_turns(context: LLMContext, max_turns: int) -> None:
    """Bound `context`'s message list to the most recent `max_turns` turns.

    A "turn" here is one user message + (usually) one assistant message.
    Keeps the last `2 * max_turns` messages, dropping the oldest ones first.
    `LLMContext` doesn't currently expose a built-in trimming knob for this
    "keep the last N turns" shape (the closest built-in mechanism,
    `LLMAutoContextSummarizationConfig`, *summarizes* older messages via an
    extra LLM call instead of dropping them -- overkill for this pipeline,
    where bounding latency, not preserving long-term memory, is the goal).

    Safe to call after every assistant turn: the system prompt is passed to
    the LLM services via `system_instruction`, not stored as a message in
    `LLMContext` (confirmed in `pipecat.services.openai.base_llm`), so
    trimming `context`'s message list can never accidentally drop it.

    No-ops if there are `2 * max_turns` messages or fewer.
    """
    max_messages = max_turns * 2
    messages = context.messages
    if len(messages) > max_messages:
        context.set_messages(messages[-max_messages:])


def build_pipeline(
    webrtc_connection: SmallWebRTCConnection, settings: Settings
) -> tuple[Pipeline, LLMContext]:
    """Construct the full translator pipeline for a single WebRTC connection.

    Picks cloud vs. offline vs. omlx STT/LLM/TTS services once, at build
    time, via `select_engine()` -- see that function's docstring for the
    selection logic (ENGINE env var, or a connectivity probe + legacy
    FORCE_OFFLINE/FORCE_ONLINE overrides when ENGINE=auto). The pipeline
    *shape* is identical across all three: only the concrete service
    instances differ.

    Returns the assembled `Pipeline` plus the `LLMContext` (handy for callers
    that want to seed/inspect conversation state). Unlike the original
    Phase-1 design, this translator now genuinely accumulates turn-by-turn
    history -- see the module docstring and `_trim_context_to_recent_turns`.
    """
    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )

    # Model Lab overrides (app/model_settings.py): loaded once per
    # connection, same lifecycle as `settings`/`engine` -- a saved settings
    # change takes effect on the *next* connection, not live mid-call (no
    # mid-conversation re-build, matching `select_engine()`'s own
    # once-per-connection contract).
    model_settings = load_model_settings()

    system_prompt = build_translation_system_prompt(
        settings.source_lang,
        settings.target_lang,
        persona_override=model_settings.llm.system_prompt_override,
    )

    direction_stripper = TranslationDirectionStripper()

    engine = select_engine(settings)
    if engine == "offline":
        stt, llm, tts = _build_local_service_trio(settings, system_prompt, model_settings)
    elif engine == "omlx":
        stt, llm, tts = _build_mlx_service_trio(settings, system_prompt, direction_stripper, model_settings)
    else:
        stt, llm, tts = _build_cloud_services(settings, system_prompt, direction_stripper, model_settings)

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

    # Bound context growth: trim to the most recent MAX_CONTEXT_TURNS turns
    # right after each assistant turn is written to context (so the *next*
    # user turn's LLM call already sees the trimmed history). See
    # `_trim_context_to_recent_turns` for why this is hand-rolled rather than
    # using LLMContext's built-in (summarization-based) mechanism.
    @assistant_aggregator.event_handler("on_assistant_turn_stopped")
    async def _on_assistant_turn_stopped(_aggregator, _message) -> None:
        _trim_context_to_recent_turns(context, MAX_CONTEXT_TURNS)

    original_tap = TranscriptTapProcessor(kind="original")
    translation_tap = TranscriptTapProcessor(kind="translation", direction_source=direction_stripper)

    pipeline = Pipeline(
        [
            transport.input(),  # Mic audio in
            stt,  # Speech -> text (source language)
            original_tap,  # Tap: forward original transcript to client
            user_aggregator,  # Build user turn for the LLM
            llm,  # Translate (Anthropic, or local Ollama model when offline)
            direction_stripper,  # Parse+strip the "[XX->YY|tone]" prefix
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
