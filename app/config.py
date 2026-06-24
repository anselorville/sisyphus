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

    return Settings(
        anthropic_api_key=os.environ["ANTHROPIC_API_KEY"],
        deepgram_api_key=os.environ["DEEPGRAM_API_KEY"],
        cartesia_api_key=os.environ["CARTESIA_API_KEY"],
        source_lang=os.environ.get("SOURCE_LANG", "Chinese"),
        target_lang=os.environ.get("TARGET_LANG", "English"),
        webrtc_host=os.environ.get("WEBRTC_HOST", "0.0.0.0"),
        webrtc_port=webrtc_port,
    )
