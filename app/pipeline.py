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

import asyncio
import re
from dataclasses import dataclass
from collections.abc import AsyncGenerator
from typing import Any

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    CancelFrame,
    DataFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InputTransportMessageFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputTransportMessageUrgentFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
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
from pipecat.services.assemblyai.stt import AssemblyAISTTService
from pipecat.services.cartesia.tts import CartesiaEmotion, CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.llm_service import LLMService
from pipecat.services.stt_service import STTService
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy
from pipecat.turns.user_start.transcription_user_turn_start_strategy import (
    TranscriptionUserTurnStartStrategy,
)
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy
from pipecat.turns.user_stop.base_user_turn_stop_strategy import BaseUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from app.config import Settings
from app.connectivity import has_internet_connection
from app.edge_tts_services import build_edge_tts
from app.latency import build_latency_observer
from app.local_services import build_local_llm, build_local_stt, build_local_tts
from app.minimax_tts_services import build_minimax_tts
from app.mlx_services import build_mlx_llm, build_mlx_stt, build_mlx_tts
from app.model_providers import (
    AVAILABLE_LOCAL_ENGINES,
    ASSEMBLYAI_DEFAULT_MODEL,
    DEEPSEEK_DEFAULT_MODEL,
    CARTESIA_DEFAULT_MODEL,
    DEEPGRAM_DEFAULT_MODEL,
    CloudProviderConfig,
    ModelProviders,
    available_models,
    load_model_providers,
    model_providers_configured,
)
from app.model_settings import ModelLabValues, load_model_settings, values_for
from app.openrouter_services import (
    build_deepseek_llm,
    build_openrouter_llm,
    build_openrouter_stt,
    build_openrouter_tts,
)
from app.voxcpm_tts_services import VOXCPM2_CUDA_PROVIDER, build_voxcpm2_cuda_tts

# Cartesia voice per language, keyed by the *short* language code we parse
# out of SOURCE_LANG/TARGET_LANG (see `_lang_code`). Sonic 3.5 can render the
# same voice across languages when paired with the correct `language` field,
# so the release default deliberately reuses one verified voice id and lets
# `_cartesia_language_for_direction()` pick pronunciation dynamically per
# translated utterance.
CARTESIA_RELEASE_VOICE_ID = "47c38ca4-5f35-497b-b1a3-415245fb35e1"

CARTESIA_VOICE_IDS: dict[str, str] = {
    "en": CARTESIA_RELEASE_VOICE_ID,
    "fr": CARTESIA_RELEASE_VOICE_ID,
    "de": CARTESIA_RELEASE_VOICE_ID,
    "es": CARTESIA_RELEASE_VOICE_ID,
    "it": CARTESIA_RELEASE_VOICE_ID,
    "zh": CARTESIA_RELEASE_VOICE_ID,
    "hu": CARTESIA_RELEASE_VOICE_ID,
    "ja": CARTESIA_RELEASE_VOICE_ID,
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
    "hungarian": "hu",
    "magyar": "hu",
    "japanese": "ja",
    "日本語": "ja",
}

_PIPECAT_LANGUAGE_BY_CODE: dict[str, Language] = {
    "en": Language.EN,
    "fr": Language.FR,
    "de": Language.DE,
    "es": Language.ES,
    "it": Language.IT,
    "zh": Language.ZH,
    "hu": getattr(Language, "HU", Language.EN),  # fallback if pipecat < hu support
    "ja": getattr(Language, "JA", Language.EN),  # fallback if pipecat < ja support
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


def _cartesia_language_for_direction(
    direction: str | None, fallback: Language | str | None
) -> Language | str | None:
    """Resolve Cartesia's synthesis language from a parsed `"SRC->DST"` tag.

    The cloud translator is bidirectional, so `TARGET_LANG=English` is only
    the startup fallback. Once the LLM emits `[ZH->EN]` or `[EN->ZH]`, TTS
    should pronounce the translated text in the destination language.
    """
    if not direction or "->" not in direction:
        return fallback
    destination_code = direction.split("->", 1)[1].strip().lower()
    return _PIPECAT_LANGUAGE_BY_CODE.get(destination_code, fallback)


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
        f"Translate ONLY the most recent user message. If several consecutive "
        f"user messages appear with no assistant reply between them, the "
        f"earlier ones are already being translated in parallel -- do NOT "
        f"re-translate or merge them into your output; translate the last "
        f"message alone. "
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


def build_assistant_system_prompt(user_lang: str) -> str:
    """Build the system prompt for the "personal assistant" conversation mode.

    Based on Cartesia's voice-agent reference prompt (see
    docs/cartesia/system-prompt.md).  The model acts as a warm, curious
    conversational partner -- no translation, no direction/tone tags, no
    language-pair constraint.  It answers questions, discusses topics, and
    keeps responses concise (1-2 sentences for a spoken conversation).

    ``user_lang`` is the free-text language name the user configured as
    their own language (e.g. "Chinese", "English") -- the assistant will
    speak this language.
    """
    # Language-specific brevity targets: every extra character costs latency
    # in both LLM generation AND TTS synthesis, so these are hard caps, not
    # suggestions.  ~50 Chinese/Japanese chars or ~30 English words is about
    # 3-5 seconds of spoken audio -- long enough for substance, short enough
    # that the user isn't waiting.
    _lang_iso = _lang_code(user_lang)
    _is_cjk = _lang_iso in ("zh", "ja", "ko")
    _len_hint = (
        "at most 50 characters" if _is_cjk
        else "at most 30 words"
    )
    _too_long_example = (
        "\"你说的这个问题很有意思。从历史上来看,人类社会的发展经历了多个阶段,每一个阶段都有其独特的特征和挑战。\""
        if _is_cjk
        else "\"That's a fascinating question. Throughout human history, societies have progressed through distinct stages, each with its own characteristics and challenges, and I think there are several perspectives worth considering here.\""
    )
    _right_example = (
        "\"这个问题挺有意思的。你是想问现在的情况,还是历史上是怎么演变的?\""
        if _is_cjk
        else "\"That's a good one. Are you asking about how it works today, or the history behind it?\""
    )

    return (
        f"You are a friendly personal voice assistant built for real-time "
        f"spoken conversation. You speak {user_lang}. Respond in {user_lang} "
        f"only. "
        f"\n\n"
        f"# Your role\n"
        f"You are a conversational partner, NOT a translator. The user wants "
        f"to talk WITH you -- ask you questions, bounce ideas, hear your "
        f"thoughts. Never echo back their words or paraphrase them. Always "
        f"add your own conversational response: an answer, an opinion, a "
        f"follow-up question, a story. "
        f"\n\n"
        f"# Brevity — THIS IS THE MOST IMPORTANT RULE\n"
        f"You are a VOICE agent. Every word you output must be spoken aloud "
        f"by a text-to-speech engine. Long responses directly hurt the user "
        f"experience: they wait longer for the LLM to generate, then wait "
        f"longer to hear it spoken. "
        f"Keep every response to {_len_hint}. If you cannot say it that "
        f"briefly, ask a follow-up question instead -- let the user guide "
        f"you to what they actually want to hear more about. "
        f"Short responses with follow-up questions are ALWAYS better than "
        f"one long answer. "
        f"\n"
        f"Example — DO NOT write like this:\n"
        f"  {_too_long_example}\n"
        f"Write like THIS instead:\n"
        f"  {_right_example}\n"
        f"\n"
        f"# Personality\n"
        f"Warm, curious, genuine, lighthearted. Knowledgeable but never "
        f"showy or pedantic. You're a thoughtful friend, not a professor "
        f"or a customer-service bot.\n"
        f"\n"
        f"# Voice and tone\n"
        f"Use natural, casual phrasing -- the way people actually talk. "
        f"Match the user's energy: playful when they're playful, grounded "
        f"when they're serious. Show genuine curiosity: \"Oh that's "
        f"interesting, tell me more\" or \"Hmm, let me think about that.\" "
        f"Never use filler compliments like \"Great question!\"\n"
        f"\n"
        f"# Response style\n"
        f"Natural spoken prose only -- no lists, no bullet points, no "
        f"markdown. One idea per response. If there's more to say, ask "
        f"whether the user wants to go deeper. End with a question often "
        f"-- it keeps the conversation moving.\n"
        f"\n"
        f"# Handling common situations\n"
        f"- Didn't catch what the user said: \"Sorry, I missed that -- say "
        f"it again?\"\n"
        f"- Genuinely don't know the answer: \"I'm actually not sure about "
        f"that one.\" (Don't make things up.)\n"
        f"- User seems frustrated or upset: Acknowledge it briefly, then "
        f"shift approach. \"That sounds frustrating. Want to talk about it?\"\n"
        f"- Off-topic or unusual request: Go with it. You can talk about "
        f"anything.\n"
        f"- Silence or very short input: \"Still there?\" or pick up the "
        f"last topic naturally.\n"
        f"\n"
        f"# What you can talk about\n"
        f"Anything: daily life, travel, science, culture, relationships, "
        f"work, philosophy, food, books, movies, personal decisions, "
        f"random thoughts. You're here for whatever the user wants to "
        f"discuss. If they seem unsure what to talk about, suggest "
        f"something light: \"Want to hear something interesting I learned "
        f"recently?\"\n"
        f"\n"
        f"# What you MUST NOT do\n"
        f"- Do NOT translate, echo, or paraphrase the user's words.\n"
        f"- Do NOT give long monologues -- if you need more than "
        f"{_len_hint}, stop and ask a question instead.\n"
        f"- Do NOT use structured formatting (lists, markdown, numbered "
        f"steps).\n"
        f"- Do NOT say \"As an AI assistant\" or similar meta-commentary.\n"
        f"- Do NOT output anything except your spoken response text -- "
        f"no prefixes, no tags, no role labels, no metadata.\n"
        f"- Do NOT ask more than one question at a time.\n"
        f"\n"
        f"# REMEMBER\n"
        f"Short + natural + one-idea-per-response. If in doubt, say less "
        f"and ask a question. The user can always ask for more detail -- "
        f"but they can't un-hear a long, slow answer."
    )


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

    For translations this legacy tap observes `TTSTextFrame`, which is only
    appropriate for providers that emit one text frame per spoken utterance.
    Cartesia emits playback-aligned text chunks, so the live pipeline uses
    `TranslationTranscriptTapProcessor` before TTS for translation UI events.
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


class TranslationTranscriptTapProcessor(FrameProcessor):
    """Emit one browser transcript event per completed translated LLM reply.

    The LLM streams `LLMTextFrame` chunks to keep TTS latency low, and Cartesia
    later emits `TTSTextFrame` chunks aligned to audio playout. The latter are
    intentionally word/character-sized, so using them for the UI makes the
    transcript look like the LLM is answering one glyph at a time and can also
    leak partial assistant text into downstream context. This tap sits after
    `TranslationDirectionStripper` and before TTS: it forwards all LLM frames
    unchanged for low-latency speech, but buffers their text until
    `LLMFullResponseEndFrame` and then sends exactly one data-channel message.
    """

    def __init__(
        self,
        *,
        direction_source: "TranslationDirectionStripper | None" = None,
        context: LLMContext | None = None,
        max_context_turns: int | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._direction_source = direction_source
        self._context = context
        self._max_context_turns = max_context_turns
        self._buffer = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._buffer = ""
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMTextFrame):
            self._buffer += frame.text
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMFullResponseEndFrame):
            text = self._buffer.strip()
            self._buffer = ""
            if text:
                if self._context is not None:
                    self._context.add_message({"role": "assistant", "content": text})
                    if self._max_context_turns is not None:
                        _trim_context_to_recent_turns(self._context, self._max_context_turns)

                payload: dict[str, Any] = {
                    "type": "transcript",
                    "kind": "translation",
                    "text": text,
                }
                if self._direction_source is not None:
                    payload["direction"] = self._direction_source.last_direction
                    payload["tone"] = self._direction_source.last_tone
                await self.push_frame(
                    OutputTransportMessageUrgentFrame(message=payload), direction
                )
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)


_SENTENCE_END_RE = re.compile(r"[。！？!?]+")

# Maximum extra wait for an unpunctuated final STT fragment. This delay sits
# directly inside the user-perceived user-stop -> bot-speech latency budget.
SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS = 0.5


class SemanticBufferProcessor(FrameProcessor):
    """Buffers STT transcription fragments until a sentence boundary is reached,
    then forwards semantically complete sentences to the LLM while keeping any
    incomplete remainder buffered for the next incoming fragment.

    Why this is needed: Deepgram streaming STT emits a final TranscriptionFrame
    per VAD-detected utterance. In real environments (background noise, speech
    hesitations, fast talking), utterances are frequently fragmented mid-sentence
    -- e.g. "我手里有你要的东" before "西。" arrives separately. Sending each
    fragment directly to the LLM causes garbage translations of incomplete inputs
    and leaves the LLM guessing at truncated meaning.

    This processor solves it by:
    1. Accumulating each TranscriptionFrame's text into a rolling buffer
    2. On each append, checking if the buffer ends with terminal punctuation
       (。！？!?) -- Deepgram adds punctuation via `punctuate=True`
    3. If yes: extracting everything up to (and including) the last sentence-end,
       pushing it as a single complete TranscriptionFrame, and keeping any
       remainder buffered
    4. If no: starting a flush timer (`flush_timeout` seconds). If no new
       fragment arrives before the timer fires, the buffer is force-flushed so
       the pipeline never stalls (handles unpunctuated speech or a long trailing
       pause)

    Position in pipeline: AFTER `original_tap` (so the UI immediately shows
    raw transcription fragments for real-time feedback) but BEFORE
    `user_aggregator` (so the LLM only ever sees complete sentences).
    """

    def __init__(
        self,
        flush_timeout: float = SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._buffer: str = ""
        self._flush_timeout = flush_timeout
        self._flush_task: "asyncio.Task[None] | None" = None
        self._last_user_id: str = ""
        self._last_timestamp: str = ""

    @property
    def buffered_text(self) -> str:
        """Return the transcription suffix still awaiting a turn boundary."""
        return self._buffer

    def _split_at_last_sentence_end(self, text: str) -> tuple[str, str]:
        """Split at the last terminal punctuation in text.

        Returns (complete_part, remainder). `complete_part` is everything up
        to and including the last sentence-end marker; `remainder` is whatever
        follows (may be empty). Returns ("", text) if no terminal punctuation
        is found.
        """
        matches = list(_SENTENCE_END_RE.finditer(text))
        if not matches:
            return "", text
        last_end = matches[-1].end()
        return text[:last_end].strip(), text[last_end:].strip()

    async def _cancel_flush_timer(self) -> None:
        if self._flush_task and not self._flush_task.done():
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
        self._flush_task = None

    async def _schedule_flush(self, direction: FrameDirection) -> None:
        try:
            await asyncio.sleep(self._flush_timeout)
            if self._buffer:
                logger.debug(
                    f"{self}: Force-flushing incomplete buffer [{self._buffer}]"
                )
                await self._flush_buffer(direction)
        except asyncio.CancelledError:
            pass

    async def _flush_buffer(self, direction: FrameDirection) -> None:
        """Push the pending transcription once and clear it atomically."""
        text = self._buffer.strip()
        self._buffer = ""
        if text:
            await self.push_frame(
                TranscriptionFrame(
                    text=text,
                    user_id=self._last_user_id,
                    timestamp=self._last_timestamp,
                ),
                direction,
            )

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            await self._cancel_flush_timer()
            text = frame.text.strip()
            if not text:
                return

            self._last_user_id = frame.user_id
            self._last_timestamp = frame.timestamp
            self._buffer = (self._buffer + text) if self._buffer else text

            complete, remainder = self._split_at_last_sentence_end(self._buffer)
            if complete:
                self._buffer = remainder
                await self.push_frame(
                    TranscriptionFrame(text=complete, user_id=frame.user_id, timestamp=frame.timestamp),
                    direction,
                )
                if remainder:
                    self._flush_task = asyncio.ensure_future(self._schedule_flush(direction))
            else:
                self._flush_task = asyncio.ensure_future(self._schedule_flush(direction))
            return

        if isinstance(frame, UserStoppedSpeakingFrame):
            await self._cancel_flush_timer()
            await self._flush_buffer(direction)
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, CancelFrame):
            await self._cancel_flush_timer()
            self._buffer = ""
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, EndFrame):
            await self._cancel_flush_timer()
            await self._flush_buffer(direction)
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)


class SentenceUserTurnStopStrategy(BaseUserTurnStopStrategy):
    """Manual mode's speculative-pipelining half: end the user turn on EVERY
    final `TranscriptionFrame`, not just on mic close.

    By the time a final TranscriptionFrame reaches the aggregator it has
    passed `SemanticBufferProcessor`, which only forwards sentence-complete
    text -- so "a final arrived" means "a complete sentence is ready to
    translate". Ending the turn right there sends that sentence to the LLM
    (-> TTS) WHILE THE USER IS STILL TALKING, instead of parking everything
    until the mic closes. The full-duplex payoff: by mic close, every
    sentence except the last is already translated and synthesized (the
    audio waits in `TTSOutputGateProcessor` until the mic closes), so the
    user only ever waits for the LAST sentence's LLM+TTS.

    The next sentence's transcription then starts a NEW turn via
    `TranscriptionUserTurnStartStrategy(enable_interruptions=False)` -- see
    `build_pipeline`'s manual-mode strategy list; interruptions must stay
    off there or each new sentence would cancel the previous sentence's
    in-flight translation.

    Interim transcriptions are deliberately ignored (only exact final
    `TranscriptionFrame`s trigger) -- interims are partial text for the UI,
    not translate-ready sentences.

    Per-sentence translation trades a little cross-sentence context within
    one utterance for the latency win; the conversation history in
    `LLMContext` (each mini-turn sees prior sentences AND their
    translations) is what keeps the quality loss small.
    """

    async def process_frame(self, frame: Frame):  # type: ignore[override]
        from pipecat.turns.types import ProcessFrameResult

        if type(frame) is TranscriptionFrame:
            await self.trigger_user_turn_stopped()
            return ProcessFrameResult.STOP
        return ProcessFrameResult.CONTINUE


class MicButtonUserTurnStartStrategy(BaseUserTurnStartStrategy):
    """User-turn start strategy for manual (mic-button) turn mode.

    Identical in shape to Pipecat's own `ExternalUserTurnStartStrategy`
    (react to a `UserStartedSpeakingFrame` some other processor emitted --
    here, `MicGateProcessor` when the client's mic button opens) except that
    interruptions are ENABLED: opening the mic while the bot is speaking is
    a deliberate user act ("stop, my turn"), so it should cancel in-flight
    LLM/TTS exactly like VAD barge-in does in auto mode. The stock External
    strategy hardcodes `enable_interruptions=False`, which would leave the
    user unable to ever cut the bot off in manual mode -- the opposite
    failure from the noisy-environment problem manual mode exists to fix
    (ambient noise interrupting TTS). With this strategy the ONLY
    interruption source is the mic button; noise has no path to one.
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(enable_interruptions=True, enable_user_speaking_frames=False, **kwargs)

    async def process_frame(self, frame: Frame):  # type: ignore[override]
        from pipecat.turns.types import ProcessFrameResult

        if isinstance(frame, UserStartedSpeakingFrame):
            await self.trigger_user_turn_started()
            return ProcessFrameResult.STOP
        return ProcessFrameResult.CONTINUE


@dataclass
class MicStateFrame(DataFrame):
    """Mic open/close state change, emitted downstream by `MicGateProcessor`
    so processors later in the pipeline (specifically
    `TTSOutputGateProcessor`) can react to the mic WITHOUT holding a
    reference back to the gate. A DataFrame (not SystemFrame) so it travels
    in order with the audio/text frames around it.
    """

    open: bool = False


# How long to wait after the client's "mic closed" data-channel message
# before emitting the turn-stop frames. The mic message rides the SCTP data
# channel while audio rides RTP -- there is NO cross-transport ordering
# guarantee, so the stop signal can overtake the last ~100-200ms of speech
# audio. (The legacy prototype hit exactly this race and solved it with a
# single FIFO -- see legacy/src-tauri/src/audio/state.rs `CaptureMsg`. A
# short grace period is the WebRTC-shaped equivalent.) Closing the mic is a
# deliberate "I'm done" gesture, so 200ms here is imperceptible next to the
# STT/LLM/TTS work that follows.
MIC_CLOSE_AUDIO_GRACE_SECONDS = 0.2


class MicGateProcessor(FrameProcessor):
    """Manual turn mode's server-side half: turns the client's mic-button
    data-channel messages into Pipecat turn frames, and hard-gates input
    audio while the mic is closed.

    Sits immediately after `transport.input()`. Handles:

    - `InputTransportMessageFrame` with `{"type": "mic", "open": bool}`
      (sent by the client whenever the mic button toggles; consumed here,
      never forwarded downstream):
      - open: push `VADUserStartedSpeakingFrame` + `UserStartedSpeakingFrame`
        downstream. The latter triggers `MicButtonUserTurnStartStrategy`
        (turn start + interruption of any in-flight bot speech).
      - close: after `MIC_CLOSE_AUDIO_GRACE_SECONDS` (see above), push
        `VADUserStoppedSpeakingFrame` + `UserStoppedSpeakingFrame`. The VAD
        variant is what streaming STT services key their force-finalization
        on (verified in Pipecat 1.4: `AssemblyAISTTService` sends
        `ForceEndpoint` on `VADUserStoppedSpeakingFrame`, and the two frame
        types are NOT in a subclass relationship, so both must be sent);
        the plain variant flushes `SemanticBufferProcessor`, whose flushed
        tail sentence then ends the final mini-turn via
        `SentenceUserTurnStopStrategy`.
    - `InputAudioRawFrame` while the mic is closed: replaced with an
      equal-length frame of silence. Zeroing (rather than dropping) keeps
      the streaming STT connection fed and alive across arbitrarily long
      idle stretches while guaranteeing ambient noise cannot reach the ASR
      -- the client also disables its audio track when the mic closes, so
      this is defense in depth, not the only gate.
    """

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
        # Grace over: from here on the audio gate (see process_frame) zeroes
        # incoming audio until the mic re-opens.
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
                # Re-opening during the close grace period: the previous
                # turn's stop frames must not fire into the new turn.
                await self._cancel_pending_close()
                await self.push_frame(MicStateFrame(open=True), direction)
                await self.push_frame(VADUserStartedSpeakingFrame(), direction)
                await self.push_frame(UserStartedSpeakingFrame(), direction)
            elif not open_requested and self._mic_open:
                self._mic_open = False
                await self._cancel_pending_close()
                # The output gate flushes on this immediately -- earlier
                # sentences' already-synthesized audio starts playing right
                # away; only the turn-stop frames wait for the tail-audio
                # grace below.
                await self.push_frame(MicStateFrame(open=False), direction)
                self._pending_close = asyncio.ensure_future(
                    self._emit_stop_after_grace(direction)
                )
            return  # mic control messages are consumed, never forwarded

        # Zero audio only once fully closed -- while the close grace period
        # is still pending, the whole point is letting the tail of the
        # user's speech (which may arrive after the mic message, see
        # MIC_CLOSE_AUDIO_GRACE_SECONDS) through to the STT.
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
    """Holds synthesized speech while the user's mic is open, releasing it
    the moment the mic closes -- the output half of manual-mode speculative
    pipelining (see `SentenceUserTurnStopStrategy`).

    While the mic is open, upstream is already translating and synthesizing
    each completed sentence. Letting that audio play immediately would talk
    over the user (and feed the bot's own voice back into the open mic);
    dropping it would waste the pre-work. So TTS frames (started/audio/
    text/stopped) are buffered here in arrival order and flushed downstream
    as soon as `MicStateFrame(open=False)` arrives. Frames arriving while
    the mic is closed (the normal tail: the LAST sentence's TTS finishing
    after mic close) pass straight through behind the flushed buffer, so
    ordering is preserved end-to-end.

    On interruption (the user re-opened the mic while buffered/playing
    audio existed -- the only interruption source in manual mode) the
    buffer is dropped: cancelled speech must not resurface at the next mic
    close. `MicStateFrame`s are consumed here; everything else non-TTS
    passes through untouched (transcript tap messages included, so the UI
    shows text the moment each sentence is translated, ahead of its audio).
    """

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
            return  # consumed: the transport has no use for it

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

    def __init__(
        self, *, tone_source: "TranslationDirectionStripper | None", **kwargs: Any
    ) -> None:
        super().__init__(**kwargs)
        self._tone_source = tone_source
        self._fallback_language = self._settings.language

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        direction = self._tone_source.last_direction if self._tone_source else None
        self._settings.language = _cartesia_language_for_direction(
            direction, self._fallback_language
        )

        tone = self._tone_source.last_tone if self._tone_source else None
        emotion = _nearest_cartesia_emotion(tone)
        if emotion is not None:
            text = f"{self.EMOTION_TAG(emotion)} {text}"
        async for frame in super().run_tts(text, context_id):
            yield frame


def _require_anthropic_key(settings: Settings) -> None:
    if not settings.anthropic_api_key:
        raise RuntimeError(
            "Cloud text capability set to 'anthropic', but ANTHROPIC_API_KEY "
            "is missing. Copy .env.example to .env and fill it in, export it "
            "in your shell, or switch the text capability's provider in the "
            "Model Provider settings."
        )


def _require_cartesia_key(settings: Settings) -> None:
    if not settings.cartesia_api_key:
        raise RuntimeError(
            "Cloud speech capability set to 'cartesia', but CARTESIA_API_KEY "
            "is missing. Copy .env.example to .env and fill it in, export it "
            "in your shell, or switch the speech capability's provider in "
            "the Model Provider settings."
        )


def _require_deepgram_key(settings: Settings) -> None:
    if not settings.deepgram_api_key:
        raise RuntimeError(
            "Cloud transcription capability set to 'deepgram', but "
            "DEEPGRAM_API_KEY is missing. Copy .env.example to .env and fill "
            "it in, export it in your shell, or switch the transcription "
            "capability's provider in the Model Provider settings."
        )


def _require_assemblyai_key(settings: Settings) -> None:
    if not settings.assemblyai_api_key:
        raise RuntimeError(
            "Cloud transcription capability set to 'assemblyai', but "
            "ASSEMBLYAI_API_KEY is missing. Add it to .env, export it in "
            "your shell, or switch the transcription capability's provider "
            "in the Model Provider settings."
        )


def _require_deepseek_key(settings: Settings) -> None:
    if not settings.deepseek_api_key:
        raise RuntimeError(
            "The text capability is set to provider 'deepseek', but "
            "DEEPSEEK_API_KEY is missing. Add it to .env or export it in "
            "your shell."
        )


def _require_openrouter_key(settings: Settings) -> None:
    if not settings.openrouter_api_key:
        raise RuntimeError(
            "A cloud capability is set to provider 'openrouter', but "
            "OPENROUTER_API_KEY is missing. Copy .env.example to .env and "
            "fill it in, or export it in your shell."
        )


def _openrouter_model_or_first(settings: Settings, catalog: list[str], configured: str | None, capability: str) -> str:
    """Resolve the OpenRouter model id to use for `capability`: the
    explicitly configured model if set, else the first entry of `catalog`,
    else a `RuntimeError` (per spec: "raise a clear RuntimeError" if both
    are unavailable).
    """
    if configured:
        return configured
    if catalog:
        return catalog[0]
    raise RuntimeError(
        f"Cloud {capability} capability set to provider 'openrouter' with no "
        f"model configured, and OPENROUTER_{capability.upper()}_MODELS has no "
        "entries to fall back to. Set a model in the Model Provider settings "
        "or populate that env var."
    )


def _build_cloud_text_service(
    settings: Settings,
    system_prompt: str,
    model_lab_values: ModelLabValues,
    cloud: CloudProviderConfig,
) -> LLMService:
    """Build the cloud translation LLM service for whichever provider is
    configured for the "text" capability (`cloud.text.provider`):

    - `None`/unset/`"anthropic"`: today's existing hardcoded default
      (Anthropic), using `cloud.text.model` if set, else Anthropic's own
      default model id.
    - `"openrouter"`: `build_openrouter_llm`, using `cloud.text.model` if
      set, else the first entry of `settings.openrouter_text_models`.

    Model Lab overrides come from the generic `cloud:text` adapter's saved
    values (see app/model_adapters/specs/cloud_text.json for the field
    list: `temperature`/`top_p`/`max_tokens`/`system_prompt_override`) --
    one shared parameter table across every cloud text provider, per the
    product owner's explicit ask (Cloud providers are broadly OpenAI-
    style/Anthropic-style compatible on these fields).
    `system_prompt_override`, if present, is expected to already have been
    folded into `system_prompt` by the caller (`build_pipeline`) via
    `build_translation_system_prompt(persona_override=...)` -- this
    function only forwards `temperature`/`top_p`/`max_tokens`.
    """
    provider = cloud.text.provider or "anthropic"
    values = values_for("cloud:text", model_lab_values)
    temperature = values.get("temperature")
    top_p = values.get("top_p")
    max_tokens = values.get("max_tokens")

    if provider == "deepseek":
        _require_deepseek_key(settings)
        # Explicit Model Provider selection wins; else the first entry of the
        # env catalog (DEEPSEEK_TEXT_MODELS); else the built-in default.
        deepseek_model = (
            cloud.text.model
            or (settings.deepseek_text_models[0] if settings.deepseek_text_models else None)
            or DEEPSEEK_DEFAULT_MODEL
        )
        return build_deepseek_llm(
            settings,
            system_prompt,
            deepseek_model,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
        )

    if provider == "openrouter":
        _require_openrouter_key(settings)
        model = _openrouter_model_or_first(
            settings, available_models(settings, "text", "openrouter"), cloud.text.model, "text"
        )
        return build_openrouter_llm(
            settings,
            system_prompt,
            model,
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
        )

    # provider == "anthropic" (default)
    _require_anthropic_key(settings)
    llm_overrides: dict[str, Any] = {}
    if cloud.text.model:
        llm_overrides["model"] = cloud.text.model
    if temperature is not None:
        llm_overrides["temperature"] = temperature
    if top_p is not None:
        llm_overrides["top_p"] = top_p
    if max_tokens is not None:
        llm_overrides["max_tokens"] = max_tokens
    return AnthropicLLMService(
        api_key=settings.anthropic_api_key,
        settings=AnthropicLLMSettings(system_instruction=system_prompt, **llm_overrides),
    )


# Known-good default voice per OpenRouter TTS model id, used only when
# Model Lab's cloud:speech.voice is unset -- so a fresh install (no
# model_settings.json) with cloud mode + openrouter speech doesn't crash at
# pipeline-build time. `en-US-Harper:MAI-Voice-2` is the exact id verified
# live this session against microsoft/mai-voice-2 (see
# app/openrouter_services.py's module docstring: every OpenAI-style voice
# name returns HTTP 400, only this Azure-locale-qualified form works).
# Deliberately NOT a single hardcoded universal default -- a different
# OpenRouter TTS model swapped into OPENROUTER_TTS_MODELS later may have a
# completely different voice-id vocabulary, so an unrecognized model id
# still raises the explicit RuntimeError below rather than guessing.
_OPENROUTER_TTS_DEFAULT_VOICE: dict[str, str] = {
    "microsoft/mai-voice-2": "en-US-Harper:MAI-Voice-2",
}

ASSEMBLYAI_BILINGUAL_PROMPT = (
    "Transcribe Mandarin Chinese and English. The speaker may switch between "
    "Chinese and English within the same conversation."
)


def _build_cloud_speech_service(
    settings: Settings,
    direction_stripper: "TranslationDirectionStripper | None",
    model_lab_values: ModelLabValues,
    cloud: CloudProviderConfig,
) -> TTSService:
    """Build the cloud TTS service for whichever provider is configured for
    the "speech" capability (`cloud.speech.provider`):

    - `None`/unset/`"cartesia"`: today's existing hardcoded default
      (Cartesia), using `cloud.speech.model` if set, else `"sonic-3.5"`.
      Voice/language/tone-wiring identical to before this feature.
    - `"openrouter"`: `build_openrouter_tts`, using `cloud.speech.model` if
      set, else the first entry of `settings.openrouter_tts_models`. Tone
      wiring: forwarded via `tone_source=direction_stripper` (see
      `OpenRouterTTSService`'s docstring) -- UNVERIFIED whether OpenRouter's
      backend actually changes output in response, unlike the Cartesia path
      which is its own separate UNVERIFIED status (no real Cartesia account
      in this environment either).

    Model Lab overrides come from the `cloud:speech` adapter's saved values
    (see app/model_adapters/specs/cloud_speech.json: `voice`/`speed`/
    `instructions_template`/`temperature`/`top_p`), one shared table across
    every cloud speech provider. VoxCPM2-CUDA is the exception: its stable
    Voice Design comes only from `VOXCPM2_CUDA_VOICE_DESIGN`, because this
    adapter field is a provider voice identifier, not a Voice Design prompt.

    `direction_stripper=None` is valid (used by app/model_lab_preview.py's
    one-shot preview calls, which have no live pipeline/tone source to read
    from) -- both `ToneAwareCartesiaTTSService`/`build_openrouter_tts`
    accept `tone_source=None` and simply never have a live tone to forward,
    falling back to the static `instructions_template` override only.
    """
    provider = cloud.speech.provider or "cartesia"
    values = values_for("cloud:speech", model_lab_values)
    voice = values.get("voice")
    speed = values.get("speed")
    instructions_template = values.get("instructions_template")
    temperature = values.get("temperature")
    top_p = values.get("top_p")

    if provider == "minimax":
        if not settings.minimax_api_key:
            raise RuntimeError(
                "Cloud speech capability set to provider 'minimax', but "
                "MINIMAX_API_KEY is missing. Add it to .env or switch the "
                "speech provider in Model Provider settings."
            )
        return build_minimax_tts(
            settings,
            direction_stripper,
            model=cloud.speech.model,
            voice=voice,
            speed=speed,
        )

    if provider == "edge_tts":
        return build_edge_tts(tone_source=direction_stripper)

    if provider == VOXCPM2_CUDA_PROVIDER:
        if not settings.voxcpm2_cuda_base_url:
            raise RuntimeError(
                "Cloud speech capability set to provider 'VoxCPM2-CUDA', but "
                "VOXCPM2_CUDA_BASE_URL is missing. Set it in .env or switch "
                "the speech capability's provider in Model Provider settings."
            )
        return build_voxcpm2_cuda_tts(
            settings,
            voice_design=settings.voxcpm2_cuda_voice_design,
        )

    if provider == "openrouter":
        _require_openrouter_key(settings)
        model = _openrouter_model_or_first(
            settings, settings.openrouter_tts_models, cloud.speech.model, "speech"
        )
        if not voice:
            voice = _OPENROUTER_TTS_DEFAULT_VOICE.get(model)
        if not voice:
            raise RuntimeError(
                "Cloud speech capability set to provider 'openrouter', but no "
                "voice is configured (Model Lab cloud:speech.voice) -- "
                "OpenRouter TTS models (e.g. mai-voice-2) require a real "
                "voice id, there is no universal default. Set one in the "
                "Model Lab settings."
            )
        return build_openrouter_tts(
            settings,
            model=model,
            voice=voice,
            default_instructions=instructions_template,
            speed=speed,
            temperature=temperature,
            top_p=top_p,
            tone_source=direction_stripper,
        )

    # provider == "cartesia" (default)
    _require_cartesia_key(settings)
    tts_overrides: dict[str, float] = {}
    if speed is not None:
        tts_overrides["speed"] = speed
    return ToneAwareCartesiaTTSService(
        tone_source=direction_stripper,
        api_key=settings.cartesia_api_key,
        settings=CartesiaTTSService.Settings(
            model=cloud.speech.model or CARTESIA_DEFAULT_MODEL,
            voice=voice or cartesia_voice_for_language(settings.target_lang),
            language=cartesia_language_for(settings.target_lang),
            **tts_overrides,
        ),
    )


def _build_cloud_transcription_service(
    settings: Settings, model_lab_values: ModelLabValues, cloud: CloudProviderConfig
) -> STTService:
    """Build the cloud STT service for whichever provider is configured for
    the "transcription" capability (`cloud.transcription.provider`):

    - `None`/unset/`"deepgram"`: today's existing hardcoded default
      (Deepgram), using `cloud.transcription.model` if set, else
      Deepgram's own default model id.
    - `"openrouter"`: `build_openrouter_stt`, using
      `cloud.transcription.model` if set, else the first entry of
      `settings.openrouter_asr_models`.

    Model Lab overrides come from the `cloud:transcription` adapter's saved
    values (see app/model_adapters/specs/cloud_transcription.json:
    `language_hint` only, deliberately sparse).
    """
    provider = cloud.transcription.provider or "deepgram"
    values = values_for("cloud:transcription", model_lab_values)
    language_hint = values.get("language_hint")

    if provider == "openrouter":
        _require_openrouter_key(settings)
        model = _openrouter_model_or_first(
            settings, settings.openrouter_asr_models, cloud.transcription.model, "transcription"
        )
        # Prefer the manifest-driven transport adapter when a manifest
        # exists for this model; fall back to the legacy hardcoded
        # OpenRouterSTTService otherwise.
        from app.openrouter_services import build_stt_from_manifest
        return build_stt_from_manifest(settings, model=model, language_hint=language_hint)

    if provider == "assemblyai":
        _require_assemblyai_key(settings)
        return AssemblyAISTTService(
            api_key=settings.assemblyai_api_key,
            settings=AssemblyAISTTService.Settings(
                model=cloud.transcription.model or ASSEMBLYAI_DEFAULT_MODEL,
                language=None,
                language_detection=None,
                prompt=ASSEMBLYAI_BILINGUAL_PROMPT,
                formatted_finals=True,
                continuous_partials=True,
            ),
        )

    # provider == "deepgram" (default)
    _require_deepgram_key(settings)
    # punctuate=True: Deepgram adds terminal punctuation (。？！ / . ? !)
    # which SemanticBufferProcessor uses to detect sentence boundaries.
    # smart_format=True: normalizes numbers, currency, dates for cleaner output.
    # interim_results=True: the DeepgramSTTService WebSocket delivers partial
    # transcriptions as the user speaks -- only final TranscriptionFrame objects
    # reach SemanticBuffer, but interim feedback shows up in the UI log faster.
    stt_settings_kwargs: dict[str, object] = {
        "model": cloud.transcription.model or DEEPGRAM_DEFAULT_MODEL,
        "punctuate": True,
        "smart_format": True,
        "interim_results": True,
    }
    if language_hint:
        try:
            stt_settings_kwargs["language"] = Language(language_hint.strip().lower())
        except ValueError:
            pass
    return DeepgramSTTService(
        api_key=settings.deepgram_api_key,
        settings=DeepgramSTTService.Settings(**stt_settings_kwargs),
    )


def _build_cloud_services(
    settings: Settings,
    system_prompt: str,
    direction_stripper: "TranslationDirectionStripper",
    model_lab_values: ModelLabValues,
    model_providers: ModelProviders,
) -> tuple[STTService, LLMService, TTSService]:
    """Build the cloud STT/LLM/TTS service trio, dispatching per-capability
    on `model_providers.cloud` (see app/model_providers.py): each of
    text/speech/transcription independently picks Anthropic/Cartesia/
    Deepgram (today's existing hardcoded defaults, used when a capability's
    provider is unset) or OpenRouter (a user-selected model from that
    capability's `settings.openrouter_*_models` catalog).

    Each per-capability builder (`_build_cloud_text_service`/
    `_build_cloud_speech_service`/`_build_cloud_transcription_service`)
    validates only the API key(s) actually needed for the provider it ends
    up building, deferred from `app.config.load_settings()` to exactly this
    point -- same posture as before this feature, just scoped per capability
    instead of requiring all three `CLOUD_REQUIRED_KEYS` unconditionally.

    `model_lab_values` (the full generic per-adapter value store) flows
    into whichever provider/model ends up active per capability via the
    shared `cloud:<capability>` adapter -- Model Provider picks WHICH
    service serves a capability, Model Lab tunes whichever one is active;
    they compose, see app/model_providers.py's module docstring.
    """
    cloud = model_providers.cloud

    stt = _build_cloud_transcription_service(settings, model_lab_values, cloud)
    llm = _build_cloud_text_service(settings, system_prompt, model_lab_values, cloud)
    tts = _build_cloud_speech_service(settings, direction_stripper, model_lab_values, cloud)

    return stt, llm, tts


def _build_local_service_trio(
    settings: Settings, system_prompt: str, model_lab_values: ModelLabValues
) -> tuple[STTService, LLMService, TTSService]:
    """Build the local/offline STT/LLM/TTS service trio (Whisper/Ollama/Piper).

    This engine (faster-whisper + Ollama + Piper) predates the per-adapter
    Model Lab redesign and has no declared `AdapterSpec` of its own (it's
    the Pi-portable fallback, not a tuning target the product owner asked
    to expose adapters for) -- left at today's hardcoded defaults, same
    behavior as before this feature, no values lookup performed.
    """
    stt = build_local_stt(settings)
    llm = build_local_llm(settings, system_prompt)
    tts = build_local_tts(settings)
    return stt, llm, tts


def _build_mlx_service_trio(
    settings: Settings,
    system_prompt: str,
    direction_stripper: "TranslationDirectionStripper",
    model_lab_values: ModelLabValues,
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

    Model Lab overrides come from the per-model-architecture adapters
    (`omlx:qwen3_5`, `omlx:voxcpm2`, `omlx:nemotron_asr`/`omlx:qwen3_asr`),
    keyed by `config_model_type` rather than the exact model id -- see
    app/model_adapters/'s module docstring. Looking up by the *configured*
    model id's `config_model_type` here (rather than hardcoding which
    adapter id applies) keeps this in sync with whichever oMLX model is
    actually loaded, the same live discovery `list_adapters` does for the
    schema endpoint.
    """
    from app.model_adapters import omlx_config_model_type  # local import: avoid import cycle at module load

    stt_model_type = omlx_config_model_type(settings, settings.omlx_stt_model)
    llm_model_type = omlx_config_model_type(settings, settings.omlx_llm_model)
    tts_model_type = omlx_config_model_type(settings, settings.omlx_tts_model)

    stt_values = values_for(f"omlx:{stt_model_type}", model_lab_values) if stt_model_type else {}
    llm_values = values_for(f"omlx:{llm_model_type}", model_lab_values) if llm_model_type else {}
    tts_values = values_for(f"omlx:{tts_model_type}", model_lab_values) if tts_model_type else {}

    stt = build_mlx_stt(settings, language_hint=stt_values.get("language_hint"))
    llm = build_mlx_llm(
        settings,
        system_prompt,
        temperature=llm_values.get("temperature"),
        top_p=llm_values.get("top_p"),
        enable_thinking=bool(llm_values.get("enable_thinking", False)),
    )
    tts = build_mlx_tts(
        settings,
        direction_stripper,
        voice=tts_values.get("voice"),
        default_instructions=tts_values.get("instructions"),
        speed=tts_values.get("speed"),
        temperature=tts_values.get("temperature"),
        top_p=tts_values.get("top_p"),
        top_k=tts_values.get("top_k"),
        repetition_penalty=tts_values.get("repetition_penalty"),
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
    # once-per-connection contract). This is the full generic
    # `{adapter_id: {field_key: value}}` store; each builder below pulls out
    # only the adapter id(s) relevant to it via `values_for`.
    model_lab_values = load_model_settings()

    # Model Provider settings (app/model_providers.py): which provider/model
    # serves each capability, loaded on the same once-per-connection
    # lifecycle as `model_lab_values` above. `load_model_providers()` itself
    # already returns all-defaults (`mode="local"`, `engine="omlx"`) when
    # model_providers.json doesn't exist on disk at all -- see that
    # function's docstring for why that default is safe: it only matters
    # *within* the "cloud"/"omlx" engine branches below, never overriding
    # `select_engine()`'s own ENGINE-env-var-driven choice, and never
    # touching the "offline" path at all (existing ENGINE=cloud/offline/omlx
    # deployments with no model_providers.json keep working unchanged).
    model_providers = load_model_providers()

    direction_stripper = TranslationDirectionStripper()

    engine = select_engine(settings)
    is_assistant = settings.conversation_mode == "assistant"

    if engine == "offline":
        # Untouched, separate, lower-tier concern -- not part of
        # model_providers.mode at all (per this feature's explicit scope).
        system_prompt = (
            build_assistant_system_prompt(settings.source_lang)
            if is_assistant
            else build_translation_system_prompt(settings.source_lang, settings.target_lang)
        )
        stt, llm, tts = _build_local_service_trio(settings, system_prompt, model_lab_values)
    elif engine == "omlx" or (model_providers_configured() and model_providers.mode == "local"):
        # "omlx" was requested explicitly via ENGINE=omlx, OR the cloud
        # engine is active but the user has EXPLICITLY chosen mode="local"
        # via the Model Provider UI (model_providers.json exists on disk) --
        # either way, behave exactly like today's omlx path.
        #
        # The `model_providers_configured()` guard is load-bearing, not
        # decorative: `load_model_providers().mode` defaults to "local" even
        # when model_providers.json doesn't exist at all (see that
        # function's docstring) -- without this guard, `mode == "local"`
        # would be true for every `ENGINE=cloud` deployment that has never
        # touched this feature, silently rerouting it to omlx instead of
        # cloud. Confirmed live: with no model_providers.json and
        # `ENGINE=cloud`, `engine == "omlx" or model_providers.mode ==
        # "local"` evaluated to `True` before this guard was added -- a real
        # regression, not a hypothetical one.
        #
        # Only "omlx" itself does anything in `local.engine` today (see
        # AVAILABLE_LOCAL_ENGINES); anything else falls back to omlx with a
        # logged warning rather than crashing, so a future second local
        # engine can be added by extending that dispatch, not this branch.
        if model_providers.local.engine not in AVAILABLE_LOCAL_ENGINES:
            logger.warning(
                f"model_providers.local.engine={model_providers.local.engine!r} "
                f"is not a supported local engine (available: "
                f"{AVAILABLE_LOCAL_ENGINES}) -- falling back to 'omlx'."
            )
        # Persona override for the omlx text adapter (`omlx:<config_model_type>`,
        # e.g. `omlx:qwen3_5`) -- resolved by the same config_model_type lookup
        # `_build_mlx_service_trio` performs internally for its other fields;
        # done once more here since the persona has to be folded into
        # `system_prompt` before that function is called, not after.
        from app.model_adapters import omlx_config_model_type

        llm_model_type = omlx_config_model_type(settings, settings.omlx_llm_model)
        llm_values = values_for(f"omlx:{llm_model_type}", model_lab_values) if llm_model_type else {}
        if is_assistant:
            system_prompt = build_assistant_system_prompt(settings.source_lang)
        else:
            system_prompt = build_translation_system_prompt(
                settings.source_lang,
                settings.target_lang,
                persona_override=llm_values.get("system_prompt_override"),
            )
        stt, llm, tts = _build_mlx_service_trio(settings, system_prompt, direction_stripper, model_lab_values)
    else:
        cloud_text_values = values_for("cloud:text", model_lab_values)
        if is_assistant:
            system_prompt = build_assistant_system_prompt(settings.source_lang)
        else:
            system_prompt = build_translation_system_prompt(
                settings.source_lang,
                settings.target_lang,
                persona_override=cloud_text_values.get("system_prompt_override"),
            )
        stt, llm, tts = _build_cloud_services(
            settings, system_prompt, direction_stripper, model_lab_values, model_providers
        )

    context = LLMContext()

    # Turn-taking (see Settings.turn_mode in app/config.py):
    #
    # - "manual" (default): the mic button owns VOICE INPUT (audio is
    #   silenced while closed -- ambient noise cannot reach the ASR or
    #   interrupt playback), while SENTENCES own turn boundaries for
    #   speculative pipelining: `MicGateProcessor` converts mic messages
    #   into turn frames + `MicStateFrame`s, `MicButtonUserTurnStartStrategy`
    #   starts the first turn (and is the ONLY interruption source), and
    #   `SentenceUserTurnStopStrategy` ends a mini-turn per completed
    #   sentence so translation/TTS run WHILE the user is still talking
    #   (audio held at `TTSOutputGateProcessor` until mic close). The Silero analyzer is still
    #   installed (below) because segmented STT services (the oMLX engine)
    #   need its VAD frames to slice utterances, and its mid-utterance stop
    #   events usefully force streaming-STT finalization early -- it just
    #   cannot start/stop turns or interrupt anymore.
    #
    # - "auto": the original hands-free behavior -- VAD starts turns and
    #   interrupts, transcription is the fallback for soft speech VAD might
    #   miss. Both explicitly constructed with enable_interruptions=True
    #   rather than relying on library defaults.
    if settings.turn_mode == "manual":
        # Speculative pipelining (see SentenceUserTurnStopStrategy /
        # TTSOutputGateProcessor): while the mic is open, every completed
        # sentence ends a mini-turn (-> LLM -> TTS immediately, audio held
        # at the output gate); the next sentence's transcription starts the
        # next mini-turn WITHOUT interrupting (or it would cancel the
        # previous sentence's in-flight translation). Only the mic button
        # itself interrupts.
        #
        # SentenceUserTurnStopStrategy is deliberately the ONLY stop
        # strategy. SemanticBufferProcessor guarantees every piece of
        # transcript -- including the unpunctuated tail after mic close
        # (flushed by the UserStoppedSpeakingFrame, or its 500ms timeout) --
        # eventually arrives as a final TranscriptionFrame, so the sentence
        # strategy covers every case. Running ExternalUserTurnStopStrategy
        # alongside it was tried first and produced DOUBLE turn-stops for
        # the same sentence (observed live: two stops 34ms apart -> the
        # same sentence translated twice, duplicate TTS, and concatenated
        # assistant context entries).
        user_turn_strategies = UserTurnStrategies(
            start=[
                MicButtonUserTurnStartStrategy(),
                TranscriptionUserTurnStartStrategy(enable_interruptions=False),
            ],
            stop=[SentenceUserTurnStopStrategy()],
        )
    else:
        user_turn_strategies = UserTurnStrategies(
            start=[
                VADUserTurnStartStrategy(enable_interruptions=True),
                TranscriptionUserTurnStartStrategy(enable_interruptions=True),
            ],
        )
    # Manual mode: the controller's stop timeout is a FORGOT-TO-CLOSE-THE-MIC
    # safety net, not the normal turn boundary (verified live: the default
    # 5s fired before the user's deliberate mic close and ended the turn on
    # its own). 30s keeps the net (an abandoned open mic still resolves)
    # while making the mic button the real boundary. Auto mode keeps the
    # library default (5s), where transcription activity resets it anyway.
    user_aggregator, _assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
            user_turn_strategies=user_turn_strategies,
            user_turn_stop_timeout=30.0 if settings.turn_mode == "manual" else 5.0,
        ),
    )

    original_tap = TranscriptTapProcessor(kind="original")
    translation_tap = TranslationTranscriptTapProcessor(
        direction_source=direction_stripper,
        context=context,
        max_context_turns=MAX_CONTEXT_TURNS,
    )
    semantic_buffer = SemanticBufferProcessor(
        flush_timeout=SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS
    )

    processors: list[FrameProcessor] = [
        transport.input(),  # Mic audio in
        stt,  # Speech -> text (source language)
        original_tap,  # Tap: forward raw transcript fragments to client immediately
        semantic_buffer,  # Buffer fragments; only forward complete sentences to LLM
        user_aggregator,  # Build user turn for the LLM
        llm,  # Translate (Anthropic, or local Ollama model when offline)
        direction_stripper,  # Parse+strip the "[XX->YY|tone]" prefix
        translation_tap,  # Tap: forward one complete translated text event to client
        tts,  # Translated text -> speech
        transport.output(),  # Speech audio out
    ]
    if settings.turn_mode == "manual":
        # Between transport input and STT: converts mic-button messages to
        # turn frames and silences audio while the mic is closed.
        processors.insert(1, MicGateProcessor())
        # Before transport output: holds speculative TTS audio while the
        # mic is open, releasing it in order the moment it closes.
        processors.insert(len(processors) - 1, TTSOutputGateProcessor())

    pipeline = Pipeline(processors)

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
        observers=[build_latency_observer()],
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )
