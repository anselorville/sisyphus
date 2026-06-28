"""Persisted "Model Provider" settings: which provider/model serves each
infrastructure capability (text/LLM, speech/TTS, transcription/ASR, plus a
reserved-but-inert "omni" slot), and whether the pipeline runs in "local"
(oMLX) or "cloud" mode at all.

This is a different axis than app/model_settings.py's "Model Lab": Model
Provider (this module) picks WHICH provider/model serves a capability; Model
Lab tunes whichever provider/model ends up active (temperature/top_p/voice/
speed/instructions/language_hint). They compose -- see app/pipeline.py's
wiring, which loads both stores and threads Model Lab overrides into
whichever service Model Provider selects.

Persistence: a single flat JSON file, `model_providers.json`, at the repo
root -- same tier/lifecycle as `model_settings.json` (gitignored,
runtime-local, loaded once per connection in app/pipeline.py's
`build_pipeline()`). Mirrors app/model_settings.py's load/save/
apply_partial_update/schema-and-payload pattern exactly; see that module's
docstring for the rationale behind that shape.

Provider/model catalogs are intentionally NOT hardcoded as a flat enum --
`available_models()` builds the per-(capability, provider) list from
`Settings` (Anthropic/Cartesia/Deepgram each have exactly one supported
model id, hardcoded to match whatever app/pipeline.py's `_build_cloud_services`
already uses today; OpenRouter's lists come from the env-var-driven catalogs
on `Settings`, see app/config.py).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

from loguru import logger

from app.config import Settings

# Repo-root JSON file. Same conceptual tier as model_settings.json: runtime-
# local, optional, gitignored. Overridable via MODEL_PROVIDERS_PATH for
# tests/tooling.
_DEFAULT_PATH = Path(
    os.environ.get(
        "MODEL_PROVIDERS_PATH", Path(__file__).resolve().parent.parent / "model_providers.json"
    )
)

ModelProviderMode = Literal["local", "cloud"]
ModelCapability = Literal["text", "speech", "transcription", "omni"]

# The only local engine that actually does anything today (see
# app/pipeline.py's `_build_mlx_service_trio`). Kept as a single named
# constant rather than scattered string literals, but `local.engine` itself
# is stored/dispatched generically (see `local_engine_dispatch_key` usage in
# app/pipeline.py) so adding a second local engine later doesn't require
# touching deep dispatch logic, only this catalog and the actual builder.
AVAILABLE_LOCAL_ENGINES: tuple[str, ...] = ("omlx",)

# Real provider ids selectable per capability. "omni" has none -- it's a
# reserved placeholder capability (see `CloudCapabilityConfig`/the spec this
# module implements), never a real dispatch target today.
CAPABILITY_PROVIDERS: dict[ModelCapability, tuple[str, ...]] = {
    "text": ("anthropic", "openrouter"),
    "speech": ("cartesia", "openrouter"),
    "transcription": ("deepgram", "openrouter"),
    "omni": (),
}

# Hardcoded single-model providers' model ids, matching exactly what
# app/pipeline.py's `_build_cloud_services` already uses today as its
# defaults:
# - Anthropic: AnthropicLLMSettings's own default model (no explicit `model=`
#   override is passed in `_build_cloud_services`, so this is
#   AnthropicLLMService's/AnthropicLLMSettings's built-in default) --
#   confirmed by reading pipecat.services.anthropic.llm's `AnthropicLLMSettings`
#   default directly: `model="claude-sonnet-4-6"`.
# - Cartesia: `model="sonic-3.5"`, hardcoded in `_build_cloud_services`.
# - Deepgram: `DeepgramSTTService.Settings`'s own default model,
#   `"nova-3-general"` (confirmed by reading
#   pipecat.services.deepgram.stt.DeepgramSTTSettings's default; verified
#   not assumed).
ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6"
CARTESIA_DEFAULT_MODEL = "sonic-3.5"
DEEPGRAM_DEFAULT_MODEL = "nova-3-general"

# Sensible OpenRouter default to surface in the UI per capability, when the
# user picks "openrouter" as a provider but hasn't chosen a specific model
# yet. NOT `nvidia/nemotron-3.5-content-safety:free` for text -- verified
# live (by the agent that built app/openrouter_services.py) to be a
# content-moderation classifier, not a translation-capable chat model. Used
# only as a *suggested* default; the actual catalog still comes from
# `settings.openrouter_text_models` etc. (see `available_models` below) --
# this is just which entry to prefer if present.
#
# `deepseek/deepseek-v4-flash`, not the free `nemotron-3-ultra:free`:
# live-measured (this session) steady-state per-translation latency of
# ~1-4s for deepseek-v4-flash/-pro (after the one-time per-session TLS
# handshake) vs. ~13s for nemotron-3-ultra:free on an identical prompt --
# a real, measured difference, not a guess. Flash over pro since the two
# measured within noise of each other in latency and flash is the cheaper
# of the two.
OPENROUTER_SUGGESTED_TEXT_MODEL = "deepseek/deepseek-v4-flash"


@dataclass
class LocalProviderConfig:
    """`mode == "local"` configuration: which local engine to use.

    `engine` defaults to `"omlx"`, the only engine that does anything today
    (see app/pipeline.py's dispatch -- anything else falls back to omlx with
    a logged warning rather than crashing, so this field is forward-looking:
    a second local engine can be added later by extending
    `AVAILABLE_LOCAL_ENGINES` and the pipeline's dispatch table, without
    needing to touch this dataclass).
    """

    engine: str = "omlx"


@dataclass
class CloudCapabilityConfig:
    """One cloud capability's selected provider/model.

    Both `None` by default, meaning "use today's existing hardcoded default
    for this capability" (Anthropic for text, Cartesia for speech, Deepgram
    for transcription) -- see app/pipeline.py's dispatch. `omni` is always
    `provider=None, model=None` and not independently settable (see
    `apply_partial_update` below, which ignores any incoming `omni` value).
    """

    provider: str | None = None
    model: str | None = None


@dataclass
class CloudProviderConfig:
    """`mode == "cloud"` configuration: one `CloudCapabilityConfig` per
    capability slot."""

    text: CloudCapabilityConfig = field(default_factory=CloudCapabilityConfig)
    speech: CloudCapabilityConfig = field(default_factory=CloudCapabilityConfig)
    transcription: CloudCapabilityConfig = field(default_factory=CloudCapabilityConfig)
    omni: CloudCapabilityConfig = field(default_factory=CloudCapabilityConfig)


@dataclass
class ModelProviders:
    """Top-level settings object: serving mode plus per-mode configuration."""

    mode: ModelProviderMode = "local"
    local: LocalProviderConfig = field(default_factory=LocalProviderConfig)
    cloud: CloudProviderConfig = field(default_factory=CloudProviderConfig)


# --------------------------------------------------------------------------
# Load / save
# --------------------------------------------------------------------------


def _providers_path() -> Path:
    return _DEFAULT_PATH


def model_providers_configured() -> bool:
    """Whether `model_providers.json` exists on disk at all -- distinct from
    `load_model_providers().mode`, which defaults to `"local"` even when the
    file is absent (see that function's docstring).

    This distinction matters for app/pipeline.py's dispatch: `mode=="local"`
    must only be able to override an `ENGINE=cloud`/`auto`-resolved "cloud"
    outcome into "omlx" when the user actually chose "Local" via the Model
    Provider UI (i.e. the file exists) -- never merely because the file has
    never been created yet, which would silently break every existing
    `ENGINE=cloud` deployment that has never touched this feature (confirmed
    live: with no file present and `ENGINE=cloud`, `load_model_providers().
    mode` is `"local"` by default, which an unconditional `mode=="local"`
    check would have incorrectly treated as an explicit choice).
    """
    return _providers_path().exists()


def load_model_providers() -> ModelProviders:
    """Load `ModelProviders` from the JSON file, or return all-defaults
    (`mode="local"`, `engine="omlx"`, every cloud capability unset) if the
    file doesn't exist or fails to parse.

    This is the first-run/no-file default app/pipeline.py falls back to --
    matching `select_engine()`'s existing `ENGINE` env var behavior, since
    `mode="local"` + `engine="omlx"`... wait: existing deployments that rely
    on `ENGINE=cloud`/`ENGINE=offline` env var behavior are NOT affected by
    this default at all -- see app/pipeline.py's wiring, which only consults
    `ModelProviders` for the "cloud" capability-dispatch *within* the
    existing `engine == "cloud"` branch, and leaves `engine == "offline"`
    completely untouched. `mode` here only matters once `select_engine()`
    has already resolved to "omlx" or "cloud" upstream.

    Unknown top-level keys/sections in the file are ignored (forward
    compatibility); unknown fields within a known section are also ignored,
    same posture as `app.model_settings.load_model_settings`.
    """
    path = _providers_path()
    if not path.exists():
        return ModelProviders()

    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return ModelProviders()

    if not isinstance(raw, dict):
        return ModelProviders()

    mode = raw.get("mode")
    if mode not in ("local", "cloud"):
        mode = "local"

    local_raw = raw.get("local") or {}
    engine = local_raw.get("engine") if isinstance(local_raw, dict) else None
    if not isinstance(engine, str) or not engine:
        engine = "omlx"

    cloud_raw = raw.get("cloud") or {}

    def _capability(key: str) -> CloudCapabilityConfig:
        data = cloud_raw.get(key) if isinstance(cloud_raw, dict) else None
        if not isinstance(data, dict):
            return CloudCapabilityConfig()
        provider = data.get("provider")
        model = data.get("model")
        return CloudCapabilityConfig(
            provider=provider if isinstance(provider, str) else None,
            model=model if isinstance(model, str) else None,
        )

    return ModelProviders(
        mode=mode,
        local=LocalProviderConfig(engine=engine),
        cloud=CloudProviderConfig(
            text=_capability("text"),
            speech=_capability("speech"),
            transcription=_capability("transcription"),
            # omni is never loaded from disk as a real value -- always
            # reset to the placeholder, even if a stale/hand-edited file has
            # something there (forward-compat / defends against a future
            # accidental write).
            omni=CloudCapabilityConfig(),
        ),
    )


def save_model_providers(providers: ModelProviders) -> None:
    """Persist `providers` to the JSON file (pretty-printed, trailing
    newline). Always writes a full snapshot, overwriting whatever was there
    before -- callers needing a partial update should load, merge, then save
    (see `apply_partial_update` below, used by the PUT endpoint).
    """
    path = _providers_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = asdict(providers)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def apply_partial_update(current: ModelProviders, partial: dict[str, Any]) -> ModelProviders:
    """Merge a partial (possibly nested-partial) providers dict from a PUT
    request body over `current`, returning a new `ModelProviders`.

    `partial` may omit `mode`/`local`/`cloud` entirely, or omit individual
    capabilities/fields within `cloud` -- only keys actually present are
    applied. Any incoming `cloud.omni` value is deliberately ignored (not
    merged) -- `omni` is a reserved placeholder, never a real settable
    field, per this module's docstring.
    """
    mode = current.mode
    if partial.get("mode") in ("local", "cloud"):
        mode = partial["mode"]

    local = current.local
    local_partial = partial.get("local")
    if isinstance(local_partial, dict) and isinstance(local_partial.get("engine"), str) and local_partial["engine"]:
        local = LocalProviderConfig(engine=local_partial["engine"])

    cloud_partial = partial.get("cloud")
    cloud = current.cloud
    if isinstance(cloud_partial, dict):
        def _merge_capability(cap_key: str, current_cap: CloudCapabilityConfig) -> CloudCapabilityConfig:
            updates = cloud_partial.get(cap_key)
            if not isinstance(updates, dict):
                return current_cap
            provider = updates.get("provider", current_cap.provider)
            model = updates.get("model", current_cap.model)
            return CloudCapabilityConfig(
                provider=provider if isinstance(provider, str) or provider is None else current_cap.provider,
                model=model if isinstance(model, str) or model is None else current_cap.model,
            )

        cloud = CloudProviderConfig(
            text=_merge_capability("text", current.cloud.text),
            speech=_merge_capability("speech", current.cloud.speech),
            transcription=_merge_capability("transcription", current.cloud.transcription),
            # omni: never merged, always the placeholder -- see docstring.
            omni=CloudCapabilityConfig(),
        )

    return ModelProviders(mode=mode, local=local, cloud=cloud)


# --------------------------------------------------------------------------
# Catalogs / schema metadata (for the client to render dropdowns)
# --------------------------------------------------------------------------


def available_models(settings: Settings, capability: ModelCapability, provider: str) -> list[str]:
    """The selectable model ids for one (capability, provider) pair.

    Single-model cloud providers (Anthropic/Cartesia/Deepgram) return their
    one hardcoded default model id as a single-entry list -- there's nothing
    else to choose from today (matching app/pipeline.py's existing hardcoded
    behavior). `openrouter` returns whichever catalog `Settings` parsed from
    its corresponding `OPENROUTER_*_MODELS` env var (empty list if unset).
    `omni`/unknown providers return an empty list.

    For `(capability="text", provider="openrouter")` specifically: the
    catalog is reordered (not filtered -- every configured entry is still
    present and selectable) so `OPENROUTER_SUGGESTED_TEXT_MODEL` sorts
    first, if it's present in the configured catalog at all. This matters
    because both this module's own pipeline-dispatch fallback
    (`app.pipeline._openrouter_model_or_first`, used when a capability's
    `model` is unset) and a plausible naive client UI default both pick
    "the first entry" -- and the raw env-var order in this repo's `.env`
    happens to put `nvidia/nemotron-3.5-content-safety:free` first, which
    was verified live (by the agent that built app/openrouter_services.py)
    to be a content-moderation classifier that always replies "User Safety:
    safe" regardless of input, not a translation-capable chat model. Without
    this reordering, both of those "pick the first one" code paths would
    silently default to a model that cannot do the pipeline's actual job.
    """
    if provider == "anthropic" and capability == "text":
        return [ANTHROPIC_DEFAULT_MODEL]
    if provider == "cartesia" and capability == "speech":
        return [CARTESIA_DEFAULT_MODEL]
    if provider == "deepgram" and capability == "transcription":
        return [DEEPGRAM_DEFAULT_MODEL]
    if provider == "openrouter":
        if capability == "text":
            catalog = list(settings.openrouter_text_models)
            if OPENROUTER_SUGGESTED_TEXT_MODEL in catalog:
                catalog.remove(OPENROUTER_SUGGESTED_TEXT_MODEL)
                catalog.insert(0, OPENROUTER_SUGGESTED_TEXT_MODEL)
            return catalog
        if capability == "speech":
            return list(settings.openrouter_tts_models)
        if capability == "transcription":
            return list(settings.openrouter_asr_models)
    return []


def effective_providers_payload(settings: Settings) -> dict[str, Any]:
    """Build the full GET/PUT response payload (see this module's docstring
    and the spec this implements -- the exact shape `client/src/hooks/
    useModelProviders.ts` expects):

        {
          "mode": "local",
          "local": {"engine": "omlx", "available_engines": ["omlx"]},
          "cloud": {
            "text": {"provider": ..., "model": ..., "available_providers": [...], "available_models": {...}},
            "speech": {...},
            "transcription": {...},
            "omni": {"provider": null, "model": null, "available_providers": [], "available_models": {}, "status": "coming_soon"},
          },
        }
    """
    providers = load_model_providers()

    def _cloud_section(capability: ModelCapability, cap_config: CloudCapabilityConfig) -> dict[str, Any]:
        provider_ids = CAPABILITY_PROVIDERS[capability]
        section: dict[str, Any] = {
            "provider": cap_config.provider,
            "model": cap_config.model,
            "available_providers": list(provider_ids),
            "available_models": {
                provider_id: available_models(settings, capability, provider_id)
                for provider_id in provider_ids
            },
        }
        if capability == "omni":
            section["status"] = "coming_soon"
        return section

    return {
        "mode": providers.mode,
        "local": {
            "engine": providers.local.engine,
            "available_engines": list(AVAILABLE_LOCAL_ENGINES),
        },
        "cloud": {
            "text": _cloud_section("text", providers.cloud.text),
            "speech": _cloud_section("speech", providers.cloud.speech),
            "transcription": _cloud_section("transcription", providers.cloud.transcription),
            "omni": _cloud_section("omni", providers.cloud.omni),
        },
    }
