"""Language capability registry for every ASR/TTS model in the pipeline.

One module answers three questions:
  1. Does model M support language L?
  2. What parameter name/value sends language L to model M?
  3. What voices are available for language L on TTS model M?

This replaces the implicit assumption that a single ``_LANGUAGE_CODES`` dict
(app/pipeline.py) suffices for every backend -- each model has its own
language set, parameter format, and voice catalog, and those differences
matter when the same language (e.g. Hungarian ``"hu"``) is passed to ten
different services that each expect it in a different shape.

Design constraints
------------------
- **Single source of truth**.  A model's supported-language list, per-language
  param format, and voice catalog live in ONE place and are imported by every
  caller that needs them (pipeline builders, Model Lab schema injection,
  edge-tts voice selection, …).
- **Read-only after import**.  All top-level dicts are module-level constants.
  Nothing mutates them at runtime -- this is a static catalogue, not a runtime
  registry.
- **Forward-compat**.  Adding a new language or model is always a single-file
  change: add an entry to the relevant dict and re-run.  No other module
  needs to be touched unless a caller wants to *use* the new entry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# ────────────────────────────────────────────────────────────────────
# Data types
# ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AsrLanguage:
    """How one ASR model expects one language to be sent."""

    iso: str  # ISO 639-1 two-letter code, e.g. "hu"
    param_value: str  # the raw value to put in the request, e.g. "hu" or "Hungarian"


@dataclass(frozen=True)
class TtsVoice:
    """One voice option for one TTS model in one language."""

    id: str  # the value to send to the model, e.g. "hu-HU-NoemiNeural"
    label: str  # human-readable, e.g. "Noemi (Female)"
    gender: Literal["male", "female", "neutral"] = "neutral"


@dataclass(frozen=True)
class TtsLanguage:
    """How one TTS model expects one language, plus its available voices."""

    iso: str
    param_value: str  # the language field value, e.g. "hu" for Cartesia or "Hungarian" for MiniMax
    voices: tuple[TtsVoice, ...]  # never empty -- at least one voice per language


# ────────────────────────────────────────────────────────────────────
# Supported languages (ISO codes)
# ────────────────────────────────────────────────────────────────────

# Ordered as they appear in the frontend language-picker grid.
ALL_LANGUAGES: tuple[str, ...] = ("zh", "en", "fr", "de", "es", "it", "hu", "ja")

# Human-readable labels for logs / debug output.
LANGUAGE_LABEL: dict[str, str] = {
    "zh": "Chinese",
    "en": "English",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "it": "Italian",
    "hu": "Hungarian",
    "ja": "Japanese",
}

# ────────────────────────────────────────────────────────────────────
# ASR models: language → request-param mapping
# ────────────────────────────────────────────────────────────────────

# Deepgram Nova-3: ``language: "hu"`` in the live transcription request.
# Pass ``None`` (omit the field) for auto-detect.
DEEPGRAM_LANGUAGES: dict[str, AsrLanguage] = {
    iso: AsrLanguage(iso=iso, param_value=iso) for iso in ALL_LANGUAGES
}

# AssemblyAI Universal-3: ``language_code: "hu"`` in the transcription config.
ASSEMBLYAI_LANGUAGES: dict[str, AsrLanguage] = {
    iso: AsrLanguage(iso=iso, param_value=iso) for iso in ALL_LANGUAGES
}

# faster-whisper (offline STT): ``language="hu"`` passed to
# ``WhisperSTTService.Settings(language=Language("hu"))``.
WHISPER_LANGUAGES: dict[str, AsrLanguage] = {
    iso: AsrLanguage(iso=iso, param_value=iso) for iso in ALL_LANGUAGES
}

# Qwen3-ASR (oMLX STT): the OpenAI-compatible ``/v1/audio/transcriptions``
# endpoint accepts ``language="Hungarian"`` (full name, not ISO code) when a
# hint is desired, or omits the field for auto-detect.  Verified live: auto-
# detect correctly handles both Chinese and English.
QWEN3_ASR_LANGUAGES: dict[str, AsrLanguage] = {
    "zh": AsrLanguage(iso="zh", param_value="Chinese"),
    "en": AsrLanguage(iso="en", param_value="English"),
    "fr": AsrLanguage(iso="fr", param_value="French"),
    "de": AsrLanguage(iso="de", param_value="German"),
    "es": AsrLanguage(iso="es", param_value="Spanish"),
    "it": AsrLanguage(iso="it", param_value="Italian"),
    "hu": AsrLanguage(iso="hu", param_value="Hungarian"),
    "ja": AsrLanguage(iso="ja", param_value="Japanese"),
}

# Nemotron ASR (oMLX STT): uses locale-style codes ``hu-HU`` via the
# ``language`` / inference-prompt field on the OpenAI-compatible endpoint.
# 40 language-locales confirmed (see model card / LinkedIn announcement).
NEMOTRON_ASR_LANGUAGES: dict[str, AsrLanguage] = {
    "zh": AsrLanguage(iso="zh", param_value="zh-CN"),
    "en": AsrLanguage(iso="en", param_value="en-US"),
    "fr": AsrLanguage(iso="fr", param_value="fr-FR"),
    "de": AsrLanguage(iso="de", param_value="de-DE"),
    "es": AsrLanguage(iso="es", param_value="es-ES"),
    "it": AsrLanguage(iso="it", param_value="it-IT"),
    "hu": AsrLanguage(iso="hu", param_value="hu-HU"),
    "ja": AsrLanguage(iso="ja", param_value="ja-JP"),
}

# Map model id → its language table.  Model ids match the keys used in
# ``app/model_providers.py``'s ``available_models()`` and the cloud/local
# dispatch in ``app/pipeline.py``.
ASR_LANGUAGE_MAP: dict[str, dict[str, AsrLanguage]] = {
    "deepgram": DEEPGRAM_LANGUAGES,
    "assemblyai": ASSEMBLYAI_LANGUAGES,
    "whisper": WHISPER_LANGUAGES,  # offline / faster-whisper
    "qwen3_asr": QWEN3_ASR_LANGUAGES,  # oMLX
    "nemotron_asr": NEMOTRON_ASR_LANGUAGES,  # oMLX
}

# ────────────────────────────────────────────────────────────────────
# TTS models: language → voice catalog
# ────────────────────────────────────────────────────────────────────

# -- Cartesia (sonic-3.5) ---------------------------------------------------
# Sonic is multilingual -- any Cartesia voice_id works with any language when
# paired with the correct ``language`` field.  The voice catalog below lists
# the *verified* per-language voices from Cartesia's public library; every
# entry currently resolves to the same ``CARTESIA_RELEASE_VOICE_ID`` (see
# app/pipeline.py) because Sonic's multilingual model doesn't require native-
# language voice recordings.  Swap in real per-language voice_ids here once a
# Cartesia account/API key is available to browse the voice library.

CARTESIA_LANGUAGES: dict[str, TtsLanguage] = {
    iso: TtsLanguage(
        iso=iso,
        param_value=iso,  # Cartesia's ``language`` field expects the ISO code
        voices=(
            TtsVoice(id="sonic-multilingual", label="Sonic (multilingual)", gender="neutral"),
        ),
    )
    for iso in ALL_LANGUAGES
}

# -- Edge TTS (Microsoft) ---------------------------------------------------
# Voice list from Microsoft's public neural-voice catalog.  Every language
# gets at least one verified voice.

EDGE_TTS_LANGUAGES: dict[str, TtsLanguage] = {
    "zh": TtsLanguage(
        iso="zh",
        param_value="zh-CN-XiaoxiaoNeural",
        voices=(
            TtsVoice(id="zh-CN-XiaoxiaoNeural", label="Xiaoxiao (Female)", gender="female"),
            TtsVoice(id="zh-CN-YunxiNeural", label="Yunxi (Male)", gender="male"),
        ),
    ),
    "en": TtsLanguage(
        iso="en",
        param_value="en-US-AriaNeural",
        voices=(
            TtsVoice(id="en-US-AriaNeural", label="Aria (Female)", gender="female"),
            TtsVoice(id="en-US-GuyNeural", label="Guy (Male)", gender="male"),
        ),
    ),
    "fr": TtsLanguage(
        iso="fr",
        param_value="fr-FR-DeniseNeural",
        voices=(
            TtsVoice(id="fr-FR-DeniseNeural", label="Denise (Female)", gender="female"),
            TtsVoice(id="fr-FR-HenriNeural", label="Henri (Male)", gender="male"),
        ),
    ),
    "de": TtsLanguage(
        iso="de",
        param_value="de-DE-KatjaNeural",
        voices=(
            TtsVoice(id="de-DE-KatjaNeural", label="Katja (Female)", gender="female"),
            TtsVoice(id="de-DE-ConradNeural", label="Conrad (Male)", gender="male"),
        ),
    ),
    "es": TtsLanguage(
        iso="es",
        param_value="es-ES-ElviraNeural",
        voices=(
            TtsVoice(id="es-ES-ElviraNeural", label="Elvira (Female)", gender="female"),
            TtsVoice(id="es-ES-AlvaroNeural", label="Alvaro (Male)", gender="male"),
        ),
    ),
    "it": TtsLanguage(
        iso="it",
        param_value="it-IT-ElsaNeural",
        voices=(
            TtsVoice(id="it-IT-ElsaNeural", label="Elsa (Female)", gender="female"),
            TtsVoice(id="it-IT-DiegoNeural", label="Diego (Male)", gender="male"),
        ),
    ),
    "hu": TtsLanguage(
        iso="hu",
        param_value="hu-HU-NoemiNeural",
        voices=(
            TtsVoice(id="hu-HU-NoemiNeural", label="Noémi (Female)", gender="female"),
            TtsVoice(id="hu-HU-TamasNeural", label="Tamás (Male)", gender="male"),
        ),
    ),
    "ja": TtsLanguage(
        iso="ja",
        param_value="ja-JP-NanamiNeural",
        voices=(
            TtsVoice(id="ja-JP-NanamiNeural", label="Nanami (Female)", gender="female"),
            TtsVoice(id="ja-JP-KeitaNeural", label="Keita (Male)", gender="male"),
        ),
    ),
}

# -- MiniMax T2A v2 (speech-2.8-hd / speech-2.8-turbo) ----------------------
# ``language_boost``: "Hungarian" (full name).  MiniMax's voice_id catalog
# (~327 ids) is independent of language -- the ``language_boost`` field is
# what controls pronunciation/accent, while ``voice_id`` selects timbre.
# Voice catalog is loaded from ``app/minimax_voices.json`` at runtime by
# ``app/model_adapters/__init__.py``; the language mapping below only covers
# the ``language_boost`` field.

_MINIMAX_LANGUAGE_BOOST: dict[str, str] = {
    "zh": "Chinese",
    "en": "English",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "it": "Italian",
    "hu": "Hungarian",
    "ja": "Japanese",
}

MINIMAX_LANGUAGES: dict[str, TtsLanguage] = {
    iso: TtsLanguage(
        iso=iso,
        param_value=boost_name,
        voices=(
            TtsVoice(id="auto", label="auto (use provider default)", gender="neutral"),
        ),
    )
    for iso, boost_name in _MINIMAX_LANGUAGE_BOOST.items()
}

# -- Piper (offline TTS) ----------------------------------------------------
# Voice models from HuggingFace ``rhasspy/piper-voices``.  Format:
# ``<locale>/<name>/<quality>``, e.g. ``hu_HU/anna/medium``.
# Quality tiers: ``low``, ``medium``, ``high`` (size/quality trade-off).
# Only ``medium`` is listed below -- the default quality tier.

PIPER_LANGUAGES: dict[str, TtsLanguage] = {
    "zh": TtsLanguage(
        iso="zh",
        param_value="zh_CN/huayan/medium",
        voices=(
            TtsVoice(id="zh_CN/huayan/medium", label="Huayan (Female)", gender="female"),
        ),
    ),
    "en": TtsLanguage(
        iso="en",
        param_value="en_US/lessac/medium",
        voices=(
            TtsVoice(id="en_US/lessac/medium", label="Lessac (Female)", gender="female"),
            TtsVoice(id="en_US/ryan/medium", label="Ryan (Male)", gender="male"),
        ),
    ),
    "fr": TtsLanguage(
        iso="fr",
        param_value="fr_FR/siwis/medium",
        voices=(
            TtsVoice(id="fr_FR/siwis/medium", label="Siwis (Male)", gender="male"),
        ),
    ),
    "de": TtsLanguage(
        iso="de",
        param_value="de_DE/eva_k/medium",
        voices=(
            TtsVoice(id="de_DE/eva_k/medium", label="Eva K (Female)", gender="female"),
        ),
    ),
    "es": TtsLanguage(
        iso="es",
        param_value="es_ES/carlfm/medium",
        voices=(
            TtsVoice(id="es_ES/carlfm/medium", label="Carl FM (Male)", gender="male"),
        ),
    ),
    "it": TtsLanguage(
        iso="it",
        param_value="it_IT/paola/medium",
        voices=(
            TtsVoice(id="it_IT/paola/medium", label="Paola (Female)", gender="female"),
        ),
    ),
    "hu": TtsLanguage(
        iso="hu",
        param_value="hu_HU/anna/medium",
        voices=(
            TtsVoice(id="hu_HU/anna/medium", label="Anna (Female)", gender="female"),
        ),
    ),
    "ja": TtsLanguage(
        iso="ja",
        param_value="ja_JP/jp/medium",
        voices=(
            TtsVoice(id="ja_JP/jp/medium", label="JP (Female)", gender="female"),
        ),
    ),
}

# -- VoxCPM2 (oMLX TTS) -----------------------------------------------------
# 30 languages confirmed on the HuggingFace model card.  Hungarian is NOT
# among them.  VoxCPM2 has only one stock voice ("default"); voice cloning
# via ref_audio/ref_text is supported by oMLX's endpoint but not wired up
# in the language map (it's a per-upload runtime feature, not a static
# voice catalog).

_VOXCPM2_LANGS: tuple[str, ...] = (
    "ar", "my", "zh", "da", "nl", "en", "fi", "fr", "de", "el",
    "he", "hi", "id", "it", "ja", "km", "ko", "lo", "ms", "no",
    "pl", "pt", "ru", "es", "sw", "sv", "tl", "th", "tr", "vi",
)

VOXCPM2_LANGUAGES: dict[str, TtsLanguage] = {
    iso: TtsLanguage(
        iso=iso,
        param_value=iso,
        voices=(
            TtsVoice(id="default", label="default (stock voice)", gender="neutral"),
        ),
    )
    for iso in ALL_LANGUAGES
    if iso in _VOXCPM2_LANGS
}

# Map model id → its language table.
TTS_LANGUAGE_MAP: dict[str, dict[str, TtsLanguage]] = {
    "cartesia": CARTESIA_LANGUAGES,
    "edge_tts": EDGE_TTS_LANGUAGES,
    "minimax": MINIMAX_LANGUAGES,
    "piper": PIPER_LANGUAGES,
    "voxcpm2": VOXCPM2_LANGUAGES,
}

# ────────────────────────────────────────────────────────────────────
# Query helpers
# ────────────────────────────────────────────────────────────────────


def asr_supports(model: str, iso: str) -> bool:
    """Does this ASR model support this ISO language code?"""
    return iso in ASR_LANGUAGE_MAP.get(model, {})


def asr_param(model: str, iso: str) -> str | None:
    """The request-param value to send to this ASR model for this language,
    or None if unsupported."""
    entry = ASR_LANGUAGE_MAP.get(model, {}).get(iso)
    return entry.param_value if entry else None


def tts_supports(model: str, iso: str) -> bool:
    """Does this TTS model support this ISO language code?"""
    return iso in TTS_LANGUAGE_MAP.get(model, {})


def tts_param(model: str, iso: str) -> str | None:
    """The request-param value to send to this TTS model for this language,
    or None if unsupported."""
    entry = TTS_LANGUAGE_MAP.get(model, {}).get(iso)
    return entry.param_value if entry else None


def tts_voices(model: str, iso: str) -> tuple[TtsVoice, ...]:
    """Available voices for this TTS model + language.  Empty tuple if
    unsupported."""
    entry = TTS_LANGUAGE_MAP.get(model, {}).get(iso)
    return entry.voices if entry else ()


def tts_default_voice(model: str, iso: str) -> str | None:
    """The first (default) voice id for this TTS model + language, or None."""
    voices = tts_voices(model, iso)
    return voices[0].id if voices else None


def tts_supported_languages(model: str) -> tuple[str, ...]:
    """All ISO codes this TTS model supports, in definition order."""
    return tuple(TTS_LANGUAGE_MAP.get(model, {}).keys())


def asr_supported_languages(model: str) -> tuple[str, ...]:
    """All ISO codes this ASR model supports, in definition order."""
    return tuple(ASR_LANGUAGE_MAP.get(model, {}).keys())
