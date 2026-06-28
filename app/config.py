"""Configuration loading for the Sisyphus translator.

Reads API keys and translation direction from environment variables (via a
.env file in development, or real environment variables in production) and
fails fast with a clear error message if anything required is missing.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# Load .env (if present) before reading any environment variables. This is a
# no-op in environments where the variables are already set (e.g. containers,
# CI) since `override=False` leaves pre-existing env vars untouched.
load_dotenv()

# Cloud API keys are intentionally NOT validated here at module/settings-load
# time. Whether they're required depends entirely on which engine ends up
# selected (see `ENGINE` below and `app/pipeline.py`'s `select_engine()`) --
# a local-only or oMLX-only user should be able to run this server with zero
# cloud keys set. The cloud-service builder (`_build_cloud_services` in
# app/pipeline.py) is responsible for validating these are present, and only
# at the point the cloud engine is actually about to be built.
CLOUD_REQUIRED_KEYS = (
    "ANTHROPIC_API_KEY",
    "DEEPGRAM_API_KEY",
    "CARTESIA_API_KEY",
)

# Valid explicit values for the `ENGINE` env var. "auto" preserves the
# original connectivity-probe-based cloud-vs-offline behavior.
VALID_ENGINES = ("auto", "cloud", "offline", "omlx")


@dataclass(frozen=True)
class Settings:
    """Resolved runtime configuration for the translator pipeline and server."""

    # Cloud credentials: may be empty strings if unset -- only validated (in
    # app/pipeline.py) if/when the cloud engine path is actually selected.
    anthropic_api_key: str
    deepgram_api_key: str
    cartesia_api_key: str
    source_lang: str
    target_lang: str
    webrtc_host: str
    webrtc_port: int

    # --- Engine selection ---
    # `engine` is one of VALID_ENGINES. "auto" (default) reproduces the
    # original behavior: probe for internet connectivity at pipeline-build
    # time and pick cloud vs. offline accordingly. "cloud"/"offline" force
    # that choice outright. "omlx" selects the third, Mac-only dev engine
    # (see app/mlx_services.py) -- never auto-selected, since it depends on
    # a local oMLX server that isn't assumed to be running.
    #
    # Backward compatibility: the legacy FORCE_OFFLINE=true/FORCE_ONLINE=true
    # env vars are still honored and mapped internally to
    # engine="offline"/engine="cloud" (see `_resolve_engine` below) if
    # `ENGINE` itself isn't set.
    engine: str

    # --- Offline/local fallback configuration ---
    # See app/connectivity.py for the startup connectivity check and
    # app/local_services.py for how these are used to build the local
    # STT/LLM/TTS services. None of these have required values: they all
    # have sensible defaults appropriate for a Raspberry Pi 5 target, and are
    # only relevant when the local path is actually selected (no internet,
    # or engine="offline").
    whisper_model: str
    ollama_base_url: str
    ollama_model: str
    piper_voice: str
    piper_download_dir: str

    # --- oMLX (Mac-only dev/test engine) configuration ---
    # See app/mlx_services.py. Only relevant when engine="omlx". NOT
    # Pi-portable: oMLX is built on Apple's MLX framework, which only runs
    # on Apple Silicon. This engine exists purely for fast local
    # iteration/testing on a Mac dev machine without spending cloud API
    # credits or needing network access -- it is never the target for the
    # eventual Raspberry Pi deployment (see README.md).
    omlx_base_url: str
    omlx_api_key: str
    omlx_llm_model: str
    omlx_stt_model: str
    omlx_tts_model: str

    # --- OpenRouter (cloud provider) configuration ---
    # See app/openrouter_services.py and app/model_providers.py. OpenRouter
    # is a single account/API key that fronts many third-party models across
    # all three capabilities this pipeline needs (text/LLM, speech/TTS,
    # transcription/ASR) -- unlike Anthropic/Deepgram/Cartesia, which are
    # each a single fixed model family. `openrouter_api_key` has no safe
    # default (a per-account secret, left empty if unset); the three
    # `_models` lists are catalogs of *selectable* model ids for
    # app/model_providers.py's settings UI, comma-split from their env
    # vars -- which one is actually in use per capability is chosen via that
    # settings store, not here. None of these are validated at
    # load_settings() time, for the same reason the existing cloud keys
    # aren't (see CLOUD_REQUIRED_KEYS above): whether OpenRouter is required
    # depends entirely on whether the user has configured it as the provider
    # for some capability via the Model Provider UI.
    openrouter_api_key: str
    openrouter_text_models: list[str]
    openrouter_tts_models: list[str]
    openrouter_asr_models: list[str]


def _parse_bool_env(name: str) -> bool:
    """Parse a boolean-ish environment variable (case-insensitive).

    Recognizes "true"/"1"/"yes"/"on" as True; anything else (including
    unset/empty) is False.
    """
    return os.environ.get(name, "").strip().lower() in ("true", "1", "yes", "on")


def _parse_csv_env(name: str) -> list[str]:
    """Parse a comma-separated env var into a list of trimmed, non-empty
    strings. Returns an empty list if unset/empty -- callers (currently
    app/model_providers.py's schema) treat an empty catalog as "OpenRouter
    has no selectable models for this capability", not an error.
    """
    raw = os.environ.get(name, "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def _resolve_engine() -> str:
    """Resolve the effective `engine` value from `ENGINE` and/or the legacy
    `FORCE_OFFLINE`/`FORCE_ONLINE` booleans.

    Precedence: an explicit `ENGINE` env var always wins. If `ENGINE` isn't
    set, fall back to the legacy booleans (`FORCE_OFFLINE=true` ->
    "offline", `FORCE_ONLINE=true` -> "cloud"). If neither is set, default
    to "auto" (the original connectivity-probe behavior).

    Raises:
        RuntimeError: if `ENGINE` is set to an unrecognized value, or if
            both legacy `FORCE_OFFLINE` and `FORCE_ONLINE` are true.
    """
    raw_engine = os.environ.get("ENGINE", "").strip().lower()
    if raw_engine:
        if raw_engine not in VALID_ENGINES:
            raise RuntimeError(
                f"ENGINE must be one of {VALID_ENGINES}, got: {raw_engine!r}"
            )
        return raw_engine

    force_offline = _parse_bool_env("FORCE_OFFLINE")
    force_online = _parse_bool_env("FORCE_ONLINE")
    if force_offline and force_online:
        raise RuntimeError(
            "FORCE_OFFLINE and FORCE_ONLINE cannot both be set to true -- "
            "pick at most one (or neither, to auto-detect), or use ENGINE instead."
        )
    if force_offline:
        return "offline"
    if force_online:
        return "cloud"
    return "auto"


def load_settings() -> Settings:
    """Read configuration from the environment.

    Note: cloud API keys (ANTHROPIC_API_KEY/DEEPGRAM_API_KEY/CARTESIA_API_KEY)
    are deliberately NOT validated here -- they're read as-is (possibly
    empty strings) and only checked for presence in app/pipeline.py's
    cloud-service builder, at the point the cloud engine is actually
    selected and about to be built. This lets local-only/oMLX-only users run
    the server with zero cloud keys configured.

    Raises:
        RuntimeError: if `WEBRTC_PORT` isn't a valid integer, or if `ENGINE`
            (or the legacy `FORCE_OFFLINE`/`FORCE_ONLINE` pair) is invalid --
            see `_resolve_engine`.
    """
    try:
        webrtc_port = int(os.environ.get("WEBRTC_PORT", "7860"))
    except ValueError as exc:
        raise RuntimeError(
            f"WEBRTC_PORT must be an integer, got: {os.environ.get('WEBRTC_PORT')!r}"
        ) from exc

    engine = _resolve_engine()

    return Settings(
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        deepgram_api_key=os.environ.get("DEEPGRAM_API_KEY", ""),
        cartesia_api_key=os.environ.get("CARTESIA_API_KEY", ""),
        source_lang=os.environ.get("SOURCE_LANG", "Chinese"),
        target_lang=os.environ.get("TARGET_LANG", "English"),
        webrtc_host=os.environ.get("WEBRTC_HOST", "0.0.0.0"),
        webrtc_port=webrtc_port,
        engine=engine,
        # "small" is a reasonable multilingual faster-whisper model for a Pi
        # 5: noticeably better accuracy than "base"/"tiny" while still
        # CPU-feasible. Tune down to "base"/"tiny" (faster, less accurate) or
        # up to "medium" (slower, more accurate) once tested on real hardware.
        whisper_model=os.environ.get("WHISPER_MODEL", "small"),
        # Ollama's default local server address and OpenAI-compatible API path.
        ollama_base_url=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
        # A small instruct model realistically capable of running on a Pi 5.
        # The user must `ollama pull` this (or whatever they override it
        # with) themselves -- see README.md.
        ollama_model=os.environ.get("OLLAMA_MODEL", "qwen2.5:1.5b"),
        # Piper voice model identifier (downloaded automatically on first use
        # if not already present in piper_download_dir).
        piper_voice=os.environ.get("PIPER_VOICE", "en_US-lessac-medium"),
        piper_download_dir=os.environ.get("PIPER_DOWNLOAD_DIR", "./models/piper"),
        # oMLX (Mac-only dev engine) -- see app/mlx_services.py. The default
        # base_url/models match a stock oMLX install with its three default
        # models loaded; omlx_api_key has no safe default (it's a per-install
        # secret) and is left empty if unset, only required when engine="omlx".
        omlx_base_url=os.environ.get("OMLX_BASE_URL", "http://127.0.0.1:6789/v1"),
        omlx_api_key=os.environ.get("OMLX_API_KEY", ""),
        omlx_llm_model=os.environ.get("OMLX_LLM_MODEL", "Qwen3.5-4B-MLX-4bit"),
        omlx_stt_model=os.environ.get("OMLX_STT_MODEL", "nemotron-3.5-asr-streaming-0.6b"),
        omlx_tts_model=os.environ.get("OMLX_TTS_MODEL", "VoxCPM2-8bit"),
        # OpenRouter (cloud provider) -- see app/openrouter_services.py and
        # app/model_providers.py. No safe default for the API key (a
        # per-account secret, left empty if unset); the three catalogs
        # default to empty lists if their env vars are unset.
        openrouter_api_key=os.environ.get("OPENROUTER_API_KEY", ""),
        openrouter_text_models=_parse_csv_env("OPENROUTER_TEXT_MODELS"),
        openrouter_tts_models=_parse_csv_env("OPENROUTER_TTS_MODELS"),
        openrouter_asr_models=_parse_csv_env("OPENROUTER_ASR_MODELS"),
    )
