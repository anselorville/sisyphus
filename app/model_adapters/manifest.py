"""Model manifest loader: the *what* of model communication.

Reads ``docs/<provider>/voice-capability-*/manifest.json`` at import time
and exposes every discovered model as a ``ModelManifest`` dataclass.  Each
manifest answers:

- **Which transport adapter?**  ``transport_protocol``: ``"http"`` or ``"websocket"``
- **Where?**  ``transport_url``: the full endpoint URL
- **What parameters?**  ``parameters``: defaults (model id, language, etc.)
- **How to encode the request?**  ``request_template``: a JSON-template dict
  with ``{model}``, ``{audio_b64}``, etc. placeholders
- **How to decode the response?**  ``response_text_path``: dotted path to
  the transcription text in the JSON response (e.g. ``"text"``)

Design
------
- **Single source of truth.**  The manifest JSON files in ``docs/`` are the
  authority.  Adding a new model means adding a manifest -- no code changes.
- **Read-only after import.**  Manifests are module-level constants.
- **Graceful degradation.**  A missing or malformed manifest is skipped with
  a logged warning; the rest of the catalogue is still available.
- **No hardcoded model list.**  ``model_providers.py``'s ``available_models()``
  can query this catalogue dynamically instead of maintaining its own
  per-provider hardcoded tuples.

Manifest JSON schema (see ``docs/openrouter/voice-capability-1784453184/manifest.json``
for a real example):

    {
      "schema_version": 1,
      "adapter_id": "openrouter.qwen/qwen3-asr-flash-2026-02-10",
      "provider": "openrouter",
      "model": "qwen/qwen3-asr-flash-2026-02-10",
      "kind": "asr",
      "api_key_env": "OPENROUTER_API_KEY",
      "auth_required": true,
      "transport": {
        "protocol": "http",
        "url": "https://openrouter.ai/api/v1/audio/transcriptions",
        "mode": "batch",
        "description": "..."
      },
      "parameters": {
        "model": "qwen/qwen3-asr-flash-2026-02-10",
        "language": null,
        ...
      },
      "assets": [{"path": "assets/input.webm", ...}]
    }

Additional fields used at runtime (NOT in the on-disk JSON -- these are
injected by the loader or computed):

- ``request_template``: the HTTP request body shape, e.g.::

      {"model": "{model}", "input_audio": {"data": "{audio_b64}", "format": "wav"}}

  Built from ``transport.protocol`` + ``kind`` at load time -- different
  protocol/kinds get different default templates.

- ``response_text_path``: where to find the transcript in the JSON response,
  e.g. ``"text"`` for OpenRouter ASR.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from loguru import logger

# Root of the manifest tree.  Each subdirectory is a provider name; within
# each provider, subdirectories matching ``voice-capability-*`` each contain
# exactly one ``manifest.json``.
_MANIFESTS_ROOT = Path(__file__).resolve().parent.parent.parent / "docs"

Capability = Literal["text", "speech", "transcription"]
TransportProtocol = Literal["http", "websocket"]


@dataclass(frozen=True)
class ModelManifest:
    """One discovered model, its transport, and its parameter defaults.

    Every field below comes from or is derived from the on-disk manifest
    JSON.  Fields marked *(injected)* are NOT in the JSON -- they are
    computed by the loader from ``transport.protocol`` + ``kind``.
    """

    # From the manifest JSON directly
    provider: str  # e.g. "openrouter", "minimax"
    model: str  # e.g. "qwen/qwen3-asr-flash-2026-02-10"
    kind: Capability  # "text" | "speech" | "transcription"
    api_key_env: str  # e.g. "OPENROUTER_API_KEY"
    auth_required: bool
    transport_protocol: TransportProtocol  # "http" | "websocket"
    transport_url: str  # full endpoint URL
    transport_mode: str  # "batch" | "stream"
    parameters: dict[str, Any]  # default parameter values (model, language, …)

    # Injected by the loader (not in the JSON)
    #   How to build the HTTP request body for this (protocol, kind) pair.
    #   ``{model}``, ``{audio_b64}``, and ``{text}`` are the supported
    #   interpolation keys.
    request_template: dict[str, Any] = field(default_factory=dict)
    #   Dotted path to the transcription text in the JSON response, e.g.
    #   ``"text"`` or ``"result.transcript"``.  Only meaningful for ASR.
    response_text_path: str = "text"

    @property
    def capability(self) -> Capability:
        """Alias for ``kind``, matching the vocabulary used in
        ``model_providers.py`` / the Model Provider UI."""
        return self.kind


# ── per-(protocol, kind) request templates ───────────────────────────

_HTTP_ASR_TEMPLATE: dict[str, Any] = {
    "model": "{model}",
    "input_audio": {
        "data": "{audio_b64}",
        "format": "wav",
    },
}

_HTTP_TTS_TEMPLATE: dict[str, Any] = {
    "model": "{model}",
    "input": "{text}",
    "voice": "{voice}",
}


def _build_request_template(protocol: str, kind: str) -> dict[str, Any] | None:
    """Return the default request body template for a (protocol, kind) pair,
    or ``None`` if this combination doesn't use HTTP request bodies (e.g.
    WebSocket transports have their own framing, not JSON bodies)."""
    if protocol == "http" and kind == "transcription":
        return dict(_HTTP_ASR_TEMPLATE)
    if protocol == "http" and kind == "speech":
        return dict(_HTTP_TTS_TEMPLATE)
    return None


# ── loader ───────────────────────────────────────────────────────────

def _load_manifest_json(path: Path) -> dict[str, Any] | None:
    """Load and validate one manifest.json.  Returns ``None`` for missing
    / unparseable / schema-mismatch files -- logged, never raised."""
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(f"Skipping manifest {path}: {exc}")
        return None

    if not isinstance(raw, dict):
        logger.warning(f"Skipping manifest {path}: not a JSON object")
        return None

    # Minimal required-field check
    required = ("provider", "model", "kind", "transport")
    missing = [k for k in required if k not in raw]
    if missing:
        logger.warning(
            f"Skipping manifest {path}: missing required fields: {missing}"
        )
        return None

    transport = raw.get("transport")
    if not isinstance(transport, dict) or "protocol" not in transport or "url" not in transport:
        logger.warning(
            f"Skipping manifest {path}: transport must be an object "
            f"with 'protocol' and 'url'"
        )
        return None

    return raw


# The docs use "asr"/"tts" as kind values; normalise to our internal
# Capability vocabulary ("transcription"/"speech").
_KIND_ALIASES: dict[str, Capability] = {
    "asr": "transcription",
    "tts": "speech",
    "text": "text",
    "transcription": "transcription",
    "speech": "speech",
}


def _parse_manifest(raw: dict[str, Any]) -> ModelManifest:
    """Build a ``ModelManifest`` from a validated raw manifest dict."""
    transport = raw["transport"]
    protocol: TransportProtocol = transport["protocol"]  # type: ignore[assignment]
    raw_kind = str(raw.get("kind", "")).lower()
    kind: Capability = _KIND_ALIASES.get(raw_kind, "text")  # type: ignore[assignment]

    template = _build_request_template(protocol, kind) or {}

    return ModelManifest(
        provider=raw["provider"],
        model=raw["model"],
        kind=kind,
        api_key_env=raw.get("api_key_env", ""),
        auth_required=bool(raw.get("auth_required", True)),
        transport_protocol=protocol,
        transport_url=transport["url"],
        transport_mode=transport.get("mode", "batch"),
        parameters=dict(raw.get("parameters", {})),
        request_template=template,
        response_text_path="text",  # default; override per-provider if needed
    )


def discover_manifests(root: Path | None = None) -> list[ModelManifest]:
    """Walk ``docs/<provider>/voice-capability-*/manifest.json`` and return
    every valid manifest found.

    ``root`` defaults to the project-level ``docs/`` directory.  Pass an
    explicit path for tests.
    """
    if root is None:
        root = _MANIFESTS_ROOT
    if not root.is_dir():
        return []

    manifests: list[ModelManifest] = []
    for manifest_path in sorted(root.rglob("voice-capability-*/manifest.json")):
        raw = _load_manifest_json(manifest_path)
        if raw is None:
            continue
        try:
            manifests.append(_parse_manifest(raw))
        except Exception as exc:
            logger.warning(f"Failed to parse manifest {manifest_path}: {exc}")
    return manifests


# ── module-level catalogue ───────────────────────────────────────────

# Loaded once at import time.  Every manifest accessible here has been
# validated and parsed -- no further I/O or validation needed at runtime.
ALL_MANIFESTS: list[ModelManifest] = discover_manifests()

# Convenience lookups
_MANIFEST_BY_PROVIDER_MODEL: dict[tuple[str, str], ModelManifest] = {
    (m.provider, m.model): m for m in ALL_MANIFESTS
}


def get_manifest(provider: str, model: str) -> ModelManifest | None:
    """Look up a manifest by (provider, model) pair.  Returns ``None`` if
    no manifest matches -- the caller falls back to its own hardcoded
    defaults (e.g. the Pipecat built-in service classes for Anthropic/
    Cartesia/Deepgram)."""
    return _MANIFEST_BY_PROVIDER_MODEL.get((provider, model))


def manifests_for_capability(kind: Capability) -> list[ModelManifest]:
    """All manifests whose ``kind`` matches the given capability
    (``"text"``, ``"speech"``, or ``"transcription"``)."""
    return [m for m in ALL_MANIFESTS if m.kind == kind]


def manifests_for_provider(provider: str) -> list[ModelManifest]:
    """All manifests for a given provider (e.g. ``"openrouter"``)."""
    return [m for m in ALL_MANIFESTS if m.provider == provider]
