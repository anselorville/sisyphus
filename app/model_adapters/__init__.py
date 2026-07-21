"""Config-file-driven "adapter spec" layer for the Model Lab.

This is the schema half of the Model Lab feature (the storage/values half is
app/model_settings.py). It answers the question "what fields are there to
tune, for this particular engine/model?" -- the product owner's explicit
ask was that this be a real per-(architecture) declaration living in actual
config files, not hand-written Python literals, so that adding tuning
support for a new local model is "drop a new JSON file in specs/", not "edit
a Python dict".

Two tiers, matching how the product actually varies:

- Cloud: ONE shared parameter table per capability (`cloud:text`,
  `cloud:speech`, `cloud:transcription`). Every cloud provider this app
  supports per capability (Anthropic/OpenRouter for text, Cartesia/
  OpenRouter for speech, Deepgram/OpenRouter for transcription) is broadly
  OpenAI-style/Anthropic-style-compatible on the handful of parameters this
  product actually exposes (temperature/top_p/voice/speed/instructions/
  language hint) -- see app/pipeline.py's `_build_cloud_*` functions, which
  already apply the same override dict regardless of which cloud provider
  ends up selected.
- Local (oMLX): one adapter PER MODEL ARCHITECTURE (keyed by oMLX's own
  `config_model_type`, e.g. `"qwen3_5"`, `"voxcpm2"`, `"nemotron_asr"` --
  NOT the exact model id string, which can change across quantization/
  version bumps of the same architecture while `config_model_type` stays
  stable). Each local architecture genuinely has different real parameters
  and valid ranges (see the spec files under `specs/`), so each gets its own
  declared adapter id (`omlx:<config_model_type>`).

--------------------------------------------------------------------------
Spec file JSON schema (one file per adapter, under `specs/*.json`)
--------------------------------------------------------------------------

    {
      "id": "omlx:qwen3_5",              // str, unique adapter id. Convention:
                                          // "cloud:<capability>" or
                                          // "omlx:<config_model_type>".
      "label": "Qwen3.5 (oMLX, local)",  // str, human-readable name for UI.
      "capability": "text",              // one of "text" | "speech" | "transcription"
      "fields": [
        {
          "key": "temperature",          // str, the field's storage key
                                          // (also the kwarg name a builder
                                          // function applies it as, where
                                          // that 1:1 mapping holds).
          "label": "Temperature",        // str, human-readable field name.
          "kind": "number",              // one of "text" | "textarea" |
                                          // "number" | "boolean" | "select".
          "min": 0.0,                    // float, optional. Only meaningful
          "max": 1.0,                    // float, optional. for kind="number".
          "step": 0.05,                  // float, optional.
          "options": ["a", "b"],         // list[str], optional. Only meaningful
                                          // for kind="select".
          "default": null,               // any, optional. Pre-fill value when
                                          // nothing has been saved yet. Omit
                                          // (or null) to mean "no default /
                                          // use the engine's own builtin".
          "help": "Explanation text."    // str, optional. Shown as field help.
        },
        ...
      ]
    }

Every key besides `id`/`label`/`capability`/`fields` is ignored (forward
compatible); within each field object, every key besides the ones listed
above is likewise ignored. A spec file that fails to parse as JSON, or
parses but is missing `id`/`label`/`capability`/`fields`, is skipped (logged
as a warning) rather than crashing server startup -- one malformed spec file
should not take down the whole Model Lab feature.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import httpx
from loguru import logger

from app.config import Settings

ParameterKind = Literal["text", "textarea", "number", "boolean", "select"]
Capability = Literal["text", "speech", "transcription"]

_SPECS_DIR = Path(__file__).resolve().parent / "specs"


@dataclass
class ParameterSpec:
    """One tunable field within an `AdapterSpec`."""

    key: str
    label: str
    kind: ParameterKind
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[str] | None = None
    default: Any = None
    help: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize for the API response, omitting unset optional fields."""
        out: dict[str, Any] = {"key": self.key, "label": self.label, "kind": self.kind}
        if self.min is not None:
            out["min"] = self.min
        if self.max is not None:
            out["max"] = self.max
        if self.step is not None:
            out["step"] = self.step
        if self.options is not None:
            out["options"] = self.options
        if self.default is not None:
            out["default"] = self.default
        if self.help is not None:
            out["help"] = self.help
        return out


@dataclass
class AdapterSpec:
    """One tuning profile: a capability's full set of tunable fields for a
    specific engine/model (cloud-shared, or one specific local architecture).
    """

    id: str
    label: str
    capability: Capability
    fields: list[ParameterSpec] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "capability": self.capability,
            "fields": [f.to_dict() for f in self.fields],
        }


_VALID_KINDS = {"text", "textarea", "number", "boolean", "select"}
_VALID_CAPABILITIES = {"text", "speech", "transcription"}


def _parse_field(raw: Any) -> ParameterSpec | None:
    if not isinstance(raw, dict):
        return None
    key = raw.get("key")
    label = raw.get("label")
    kind = raw.get("kind")
    if not isinstance(key, str) or not key:
        return None
    if not isinstance(label, str) or not label:
        label = key
    if kind not in _VALID_KINDS:
        return None

    def _num(name: str) -> float | None:
        v = raw.get(name)
        return float(v) if isinstance(v, (int, float)) else None

    options = raw.get("options")
    options = [str(o) for o in options] if isinstance(options, list) else None
    help_text = raw.get("help")
    help_text = help_text if isinstance(help_text, str) else None

    return ParameterSpec(
        key=key,
        label=label,
        kind=kind,  # type: ignore[arg-type]
        min=_num("min"),
        max=_num("max"),
        step=_num("step"),
        options=options,
        default=raw.get("default"),
        help=help_text,
    )


def _parse_adapter_spec(raw: Any, *, source: str) -> AdapterSpec | None:
    if not isinstance(raw, dict):
        logger.warning(f"Skipping model adapter spec {source}: not a JSON object")
        return None
    adapter_id = raw.get("id")
    label = raw.get("label")
    capability = raw.get("capability")
    fields_raw = raw.get("fields")
    if not isinstance(adapter_id, str) or not adapter_id:
        logger.warning(f"Skipping model adapter spec {source}: missing/invalid 'id'")
        return None
    if not isinstance(label, str) or not label:
        label = adapter_id
    if capability not in _VALID_CAPABILITIES:
        logger.warning(
            f"Skipping model adapter spec {source}: 'capability' must be one of "
            f"{sorted(_VALID_CAPABILITIES)}, got {capability!r}"
        )
        return None
    if not isinstance(fields_raw, list):
        fields_raw = []
    parsed_fields = [pf for raw_field in fields_raw if (pf := _parse_field(raw_field)) is not None]

    return AdapterSpec(id=adapter_id, label=label, capability=capability, fields=parsed_fields)


def _load_all_specs() -> dict[str, AdapterSpec]:
    """Load every `*.json` file in `specs/` into an `{adapter_id: AdapterSpec}`
    dict. Malformed files are skipped with a logged warning, not raised.
    """
    specs: dict[str, AdapterSpec] = {}
    if not _SPECS_DIR.exists():
        return specs
    for path in sorted(_SPECS_DIR.glob("*.json")):
        try:
            raw = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(f"Skipping model adapter spec {path}: {exc}")
            continue
        adapter = _parse_adapter_spec(raw, source=str(path))
        if adapter is not None:
            specs[adapter.id] = adapter
    return specs


# Loaded once at import time -- spec files are part of the source tree (like
# any other app code), not runtime-mutable state, so there's no need to
# re-read them from disk on every request. A process restart picks up edited/
# added spec files, same lifecycle as any other Python source change.
_SPECS_BY_ID: dict[str, AdapterSpec] = _load_all_specs()


def _unrecognized_stub(adapter_id: str, label: str, capability: Capability) -> AdapterSpec:
    """A placeholder adapter with no fields, for a local model whose
    architecture has no matching spec file yet (or whose oMLX status lookup
    failed). Surfacing a real (if empty) adapter, rather than omitting local
    tuning entirely, keeps `list_adapters`'s shape consistent regardless of
    whether tuning support has been written for the currently-configured
    local model.
    """
    return AdapterSpec(id=adapter_id, label=label, capability=capability, fields=[])


# Maps oMLX's `config_model_type` (confirmed live: "qwen3_5", "voxcpm2",
# "nemotron_asr", "qwen3_asr") to the capability it serves, purely so
# `list_adapters` can sanity-check a discovered model_type actually matches
# the capability being asked about (a defensive check, not load-bearing for
# normal operation -- the spec file's own declared `capability` is what
# actually determines the response shape).
_OMLX_SETTINGS_FIELD_BY_CAPABILITY = {
    "text": "omlx_llm_model",
    "speech": "omlx_tts_model",
    "transcription": "omlx_stt_model",
}


def _configured_omlx_model_id(settings: Settings, capability: Capability) -> str | None:
    field_name = _OMLX_SETTINGS_FIELD_BY_CAPABILITY.get(capability)
    if field_name is None:
        return None
    return getattr(settings, field_name, None)


def omlx_config_model_type(settings: Settings, model_id: str) -> str | None:
    """Look up `config_model_type` for `model_id` via a live `GET
    /v1/models/status` call against `settings.omlx_base_url`.

    Public (not underscore-prefixed) because app/pipeline.py's
    `_build_mlx_service_trio` also needs this exact lookup (keyed by
    `config_model_type`, not the raw model id -- see this module's
    docstring for why) to resolve which adapter's saved values apply to
    each of the three configured oMLX models, without duplicating the
    `GET /v1/models/status` lookup logic in two places.

    Returns `None` (rather than raising) if oMLX is unreachable/unconfigured,
    the model id isn't present in the response, or the response is malformed
    -- callers fall back to an "unrecognized model" stub adapter in any of
    these cases (see `list_adapters`), since a tuning-profile lookup failure
    should never prevent the rest of the Model Lab (or the pipeline) from
    working.
    """
    if not settings.omlx_base_url or not settings.omlx_api_key:
        return None
    try:
        with httpx.Client(
            base_url=settings.omlx_base_url,
            headers={"Authorization": f"Bearer {settings.omlx_api_key}"},
            timeout=10.0,
        ) as client:
            response = client.get("/models/status")
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(f"oMLX model-status lookup failed (server unreachable?): {exc}")
        return None

    for model in data.get("models", []):
        if model.get("id") == model_id:
            config_model_type = model.get("config_model_type")
            return config_model_type if isinstance(config_model_type, str) else None
    return None


async def _omlx_config_model_type_async(settings: Settings, model_id: str) -> str | None:
    """Async equivalent of `_omlx_config_model_type`, for callers already
    running inside an event loop (e.g. FastAPI endpoint handlers) that
    shouldn't block on a synchronous `httpx.Client` call.
    """
    if not settings.omlx_base_url or not settings.omlx_api_key:
        return None
    try:
        async with httpx.AsyncClient(
            base_url=settings.omlx_base_url,
            headers={"Authorization": f"Bearer {settings.omlx_api_key}"},
            timeout=10.0,
        ) as client:
            response = await client.get("/models/status")
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(f"oMLX model-status lookup failed (server unreachable?): {exc}")
        return None

    for model in data.get("models", []):
        if model.get("id") == model_id:
            config_model_type = model.get("config_model_type")
            return config_model_type if isinstance(config_model_type, str) else None
    return None


def _cloud_adapter_id(capability: Capability) -> str:
    return f"cloud:{capability}"


def _inject_voice_options(spec: AdapterSpec) -> AdapterSpec:
    """Create a copy of `spec` with dynamically-injected voice options for
    voxcpm2 (if applicable).

    For the "omlx:voxcpm2" adapter, replaces the static voice options list
    with ["default"] + [v["id"] for v in list_voices()], ensuring the UI
    always reflects the current voice library.

    Returns the modified spec (a shallow copy; the fields list is replaced).
    For non-voxcpm2 specs, returns the spec unchanged.
    """
    if spec.id != "omlx:voxcpm2":
        return spec

    from app import voice_library

    available_voices = [v["id"] for v in voice_library.list_voices()]
    voice_options = ["default"] + available_voices

    new_fields = []
    for field in spec.fields:
        if field.key == "voice":
            new_field = ParameterSpec(
                key=field.key,
                label=field.label,
                kind=field.kind,
                min=field.min,
                max=field.max,
                step=field.step,
                options=voice_options,
                default=field.default,
                help=field.help,
            )
            new_fields.append(new_field)
        else:
            new_fields.append(field)

    return AdapterSpec(
        id=spec.id,
        label=spec.label,
        capability=spec.capability,
        fields=new_fields,
    )


def _local_adapter_for(
    capability: Capability, settings: Settings, *, config_model_type: str | None
) -> AdapterSpec:
    """Resolve the local (oMLX) adapter for `capability`: the spec matching
    the live-discovered `config_model_type`, or an "unrecognized model, no
    tuning profile yet" stub if the lookup failed or no spec file matches.

    For voxcpm2, dynamically injects available voice options from the voice
    library.
    """
    model_id = _configured_omlx_model_id(settings, capability) or "(unconfigured)"
    if config_model_type is None:
        return _unrecognized_stub(
            adapter_id=f"omlx:unrecognized:{capability}",
            label=f"{model_id} (unrecognized model, no tuning profile yet)",
            capability=capability,
        )
    adapter_id = f"omlx:{config_model_type}"
    spec = _SPECS_BY_ID.get(adapter_id)
    if spec is not None:
        return _inject_voice_options(spec)
    return _unrecognized_stub(
        adapter_id=adapter_id,
        label=f"{model_id} ({config_model_type}, no tuning profile yet)",
        capability=capability,
    )


def _cloud_adapter_for(capability: Capability) -> AdapterSpec:
    """Resolve the shared cloud adapter for `capability`, with
    provider-aware dynamic voice options for speech.

    When the configured cloud speech provider is `minimax`, the `voice`
    field becomes a select over the known MiniMax voice_id catalog (327
    system voices, see app/minimax_voices.json) instead of a free-text
    field -- same shallow-copy-don't-mutate pattern as
    `_inject_voice_options` for the voxcpm2 voice library. Any other
    provider (Cartesia UUIDs, OpenRouter Azure-locale ids, ...) keeps the
    free-text field, since those vocabularies aren't enumerable here.
    """
    spec = _SPECS_BY_ID.get(_cloud_adapter_id(capability))
    if spec is None:
        return _unrecognized_stub(
            adapter_id=_cloud_adapter_id(capability),
            label=f"Cloud ({capability})",
            capability=capability,
        )
    if capability != "speech":
        return spec

    from app.minimax_tts_services import minimax_voice_ids
    from app.model_providers import load_model_providers

    if load_model_providers().cloud.speech.provider != "minimax":
        return spec
    voices = minimax_voice_ids()
    if not voices:
        return spec

    new_fields = []
    for field_spec in spec.fields:
        if field_spec.key == "voice":
            new_fields.append(
                ParameterSpec(
                    key=field_spec.key,
                    label=field_spec.label,
                    kind="select",
                    min=field_spec.min,
                    max=field_spec.max,
                    step=field_spec.step,
                    options=voices,
                    default=field_spec.default,
                    help=(
                        "MiniMax system voice (voice_id). Leave on Default "
                        "to use the built-in default voice."
                    ),
                )
            )
        else:
            new_fields.append(field_spec)
    return AdapterSpec(id=spec.id, label=spec.label, capability=spec.capability, fields=new_fields)


def list_adapters(capability: Capability, settings: Settings) -> list[AdapterSpec]:
    """The full list of adapters selectable for `capability`: always exactly
    one `cloud:<capability>` adapter, plus the local adapter matching
    whichever oMLX model is currently configured for that capability (a
    real spec-file match if one exists, else an "unrecognized model" stub --
    see `_local_adapter_for`).

    Synchronous (uses a blocking `httpx.Client` for the oMLX status lookup)
    -- fine for the small number of calls this makes (one GET per
    capability, each independently cached for nothing, called once per
    `/api/model-lab/schema` request). See `list_adapters_async` for an
    async-friendly equivalent FastAPI handlers should prefer.
    """
    cloud = _cloud_adapter_for(capability)
    model_id = _configured_omlx_model_id(settings, capability)
    config_model_type = omlx_config_model_type(settings, model_id) if model_id else None
    local = _local_adapter_for(capability, settings, config_model_type=config_model_type)
    return [cloud, local]


async def list_adapters_async(capability: Capability, settings: Settings) -> list[AdapterSpec]:
    """Async equivalent of `list_adapters`, for use inside FastAPI handlers."""
    cloud = _cloud_adapter_for(capability)
    model_id = _configured_omlx_model_id(settings, capability)
    config_model_type = await _omlx_config_model_type_async(settings, model_id) if model_id else None
    local = _local_adapter_for(capability, settings, config_model_type=config_model_type)
    return [cloud, local]


def get_adapter(adapter_id: str, capability: Capability, settings: Settings) -> AdapterSpec | None:
    """Resolve a single adapter by id, scoped to `capability` (an adapter id
    that exists but belongs to a different capability is treated as not
    found -- callers should not be able to e.g. apply a `cloud:speech`
    adapter's fields against a text preview by id confusion).

    Synchronous; see `get_adapter_async` for FastAPI handlers.
    """
    for adapter in list_adapters(capability, settings):
        if adapter.id == adapter_id:
            return adapter
    # Also check the static spec table directly, in case the id is a real
    # spec (e.g. another local model's adapter) not currently the active one
    # for this capability -- still scoped to matching capability.
    spec = _SPECS_BY_ID.get(adapter_id)
    if spec is not None and spec.capability == capability:
        return spec
    return None


async def get_adapter_async(adapter_id: str, capability: Capability, settings: Settings) -> AdapterSpec | None:
    """Async equivalent of `get_adapter`."""
    for adapter in await list_adapters_async(capability, settings):
        if adapter.id == adapter_id:
            return adapter
    spec = _SPECS_BY_ID.get(adapter_id)
    if spec is not None and spec.capability == capability:
        return spec
    return None
