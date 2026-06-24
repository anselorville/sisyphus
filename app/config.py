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

_REQUIRED_KEYS = (
    "ANTHROPIC_API_KEY",
    "DEEPGRAM_API_KEY",
    "CARTESIA_API_KEY",
)


@dataclass(frozen=True)
class Settings:
    """Resolved runtime configuration for the translator pipeline and server."""

    anthropic_api_key: str
    deepgram_api_key: str
    cartesia_api_key: str
    source_lang: str
    target_lang: str
    webrtc_host: str
    webrtc_port: int

    # --- Offline/local fallback configuration ---
    # See app/connectivity.py for the startup connectivity check and
    # app/local_services.py for how these are used to build the local
    # STT/LLM/TTS services. None of these have required values: they all
    # have sensible defaults appropriate for a Raspberry Pi 5 target, and are
    # only relevant when the local path is actually selected (no internet,
    # or FORCE_OFFLINE=true).
    force_offline: bool
    force_online: bool
    whisper_model: str
    ollama_base_url: str
    ollama_model: str
    piper_voice: str
    piper_download_dir: str


def _parse_bool_env(name: str) -> bool:
    """Parse a boolean-ish environment variable (case-insensitive).

    Recognizes "true"/"1"/"yes"/"on" as True; anything else (including
    unset/empty) is False.
    """
    return os.environ.get(name, "").strip().lower() in ("true", "1", "yes", "on")


def load_settings() -> Settings:
    """Read and validate configuration from the environment.

    Raises:
        RuntimeError: if any required API key is missing, with a message
            naming exactly which environment variables need to be set.
    """
    missing = [key for key in _REQUIRED_KEYS if not os.environ.get(key)]
    if missing:
        raise RuntimeError(
            "Missing required environment variable(s): "
            f"{', '.join(missing)}. Copy .env.example to .env and fill in "
            "the missing API key(s), or export them in your shell."
        )

    try:
        webrtc_port = int(os.environ.get("WEBRTC_PORT", "7860"))
    except ValueError as exc:
        raise RuntimeError(
            f"WEBRTC_PORT must be an integer, got: {os.environ.get('WEBRTC_PORT')!r}"
        ) from exc

    force_offline = _parse_bool_env("FORCE_OFFLINE")
    force_online = _parse_bool_env("FORCE_ONLINE")
    if force_offline and force_online:
        raise RuntimeError(
            "FORCE_OFFLINE and FORCE_ONLINE cannot both be set to true -- "
            "pick at most one (or neither, to auto-detect)."
        )

    return Settings(
        anthropic_api_key=os.environ["ANTHROPIC_API_KEY"],
        deepgram_api_key=os.environ["DEEPGRAM_API_KEY"],
        cartesia_api_key=os.environ["CARTESIA_API_KEY"],
        source_lang=os.environ.get("SOURCE_LANG", "Chinese"),
        target_lang=os.environ.get("TARGET_LANG", "English"),
        webrtc_host=os.environ.get("WEBRTC_HOST", "0.0.0.0"),
        webrtc_port=webrtc_port,
        force_offline=force_offline,
        force_online=force_online,
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
    )
