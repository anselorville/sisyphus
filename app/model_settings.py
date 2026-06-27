"""Persisted, user-tunable model-parameter overrides (the "Model Lab").

The product owner's explicit ask (see the PR description this module was
introduced for): tuning ASR/LLM/TTS parameters -- whether the active engine
is cloud or local -- should be a first-class, persisted, per-(engine,
model-role) settings surface, not a pile of hardcoded constants buried in
app/pipeline.py / app/mlx_services.py / app/local_services.py. This module
is the storage + schema layer for that surface; app/server.py exposes it
over HTTP (GET/PUT /api/model-settings), and client/ renders it as the
"Model Lab" screen.

This store is purely additive/optional: every field defaults to "use
whatever the pipeline already hardcodes today" (`None`, in practice, for
every override field below). Nothing in this module changes pipeline
behavior by itself -- see the "INTEGRATION POINT" note below for the one
wiring change still needed in app/pipeline.py (deliberately NOT made here,
per this task's scope constraints).

Persistence: a single flat JSON file, `model_settings.json`, at the repo
root (see `_DEFAULT_PATH`). Same tier as `.env`/`models/` -- runtime-local
state, gitignored, never committed.

--------------------------------------------------------------------------
INTEGRATION POINT for the next change to app/pipeline.py
--------------------------------------------------------------------------
`build_translation_system_prompt(source_lang, target_lang)` currently
generates a system prompt that conflates two conceptually distinct things:

  (a) STRUCTURAL output-format contract -- the `[XX->YY|tone]` prefix the
      model is told to emit, which `TranslationDirectionStripper` /
      `parse_direction_prefix` structurally depend on to route
      direction+tone metadata through the rest of the pipeline. This is
      non-negotiable plumbing; it cannot be overridden by a user without
      breaking transcript tagging, TTS tone-forwarding, etc.

  (b) PERSONA/BEHAVIOR instructions -- "you are a translation engine, not
      a conversational assistant", "don't engage with the content", the
      silent-ASR-correction instruction, the tone-inference instruction,
      etc. This is exactly what the product owner wants fully replaceable
      ("this product isn't a cold translation machine... having LLM
      settings means the product can become any persona at any time").

To wire `LlmModelSettings.system_prompt_override` (below) into the real
pipeline, `build_translation_system_prompt` needs a new optional parameter,
e.g.:

    def build_translation_system_prompt(
        source_lang: str,
        target_lang: str,
        *,
        persona_override: str | None = None,
    ) -> str:
        ...

When `persona_override` is given (non-None/non-empty), it REPLACES only
part (b) -- the persona/behavior prose -- while part (a) (the `[XX->YY|tone]`
format contract: the exact instruction to detect direction, emit the tag in
that exact shape, and the parsing rules `parse_direction_prefix` depends
on) is still appended/enforced verbatim, regardless of the override. A
reasonable shape: keep the format-contract paragraph(s) as a fixed suffix
template, and use `persona_override or DEFAULT_PERSONA_TEXT` for the prefix
prose, then concatenate.

The call site to update is `build_pipeline()` (also app/pipeline.py):

    system_prompt = build_translation_system_prompt(settings.source_lang, settings.target_lang)

becomes (illustrative):

    model_settings = load_model_settings()
    system_prompt = build_translation_system_prompt(
        settings.source_lang,
        settings.target_lang,
        persona_override=model_settings.llm.system_prompt_override,
    )

Similarly, `temperature`/`top_p` from `LlmModelSettings` would need to flow
into whichever of `AnthropicLLMSettings`/`OpenAILLMService.Settings` is
constructed in `_build_cloud_services`/`_build_mlx_service_trio`/
`app.local_services.build_local_llm`, and the TTS/STT fields below into the
corresponding service Settings in those same builder functions.

This module was deliberately kept ignorant of pipecat/pipeline internals
(no imports from app.pipeline / app.mlx_services / app.local_services) so
it has zero risk of import-time coupling or circular imports with those
in-flight files.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

# Repo-root JSON file. Same conceptual tier as .env: runtime-local, optional,
# gitignored. Overridable via MODEL_SETTINGS_PATH for tests/tooling.
_DEFAULT_PATH = Path(
    os.environ.get("MODEL_SETTINGS_PATH", Path(__file__).resolve().parent.parent / "model_settings.json")
)


# --------------------------------------------------------------------------
# Per-role settings dataclasses
# --------------------------------------------------------------------------


@dataclass
class LlmModelSettings:
    """User-tunable overrides for the translation LLM (the pipeline's
    "brain" -- see this module's docstring on why `system_prompt_override`
    exists and how it must be integrated).

    All fields default to `None`, meaning "use today's hardcoded pipeline
    behavior" -- this dataclass changes nothing by itself until the
    INTEGRATION POINT documented above is wired up.
    """

    # Replaces only the persona/behavior portion of the system prompt (see
    # module docstring) when set to a non-empty string. `None` (the
    # default) means "use the built-in translator persona".
    system_prompt_override: str | None = None
    temperature: float | None = None
    top_p: float | None = None


@dataclass
class TtsModelSettings:
    """User-tunable overrides for TTS.

    `voice`/`speed`/`instructions_template` are deliberately engine-agnostic
    names at this level; per-engine semantics differ (see the `schema()`
    metadata in `model_settings_schema()` below for what's genuinely
    available per engine):

    - oMLX (`/v1/audio/speech`, see app/mlx_services.py): `voice` is mostly
      moot today (VoxCPM2 only really has "default"; `ref_audio`/`ref_text`
      voice cloning exists server-side but isn't wired up in
      `build_mlx_tts`). `speed`, `instructions` (free-text style/delivery
      hint -- this is the field verified live to measurably change output,
      see `MlxTTSService.run_tts`), `temperature`/`top_p`/`top_k`/
      `repetition_penalty` are all real, accepted fields on oMLX's
      `AudioSpeechRequest` schema (confirmed live against the running oMLX
      server's /openapi.json).
    - Cartesia (`CartesiaTTSService`, see app/pipeline.py): `voice` is a
      `voice_id` (today hardcoded per-language in `CARTESIA_VOICE_IDS`);
      `speed` and an `emotion` string map onto Cartesia's
      `GenerationConfig.speed`/`GenerationConfig.emotion` (over 60 named
      emotions -- see `pipecat.services.cartesia.tts.CartesiaEmotion`).
      `instructions_template` has no Cartesia equivalent as free text, but
      the closest analog is the emotion enum value.
    """

    voice: str | None = None
    speed: float | None = None
    instructions_template: str | None = None
    temperature: float | None = None
    top_p: float | None = None


@dataclass
class SttModelSettings:
    """User-tunable overrides for STT/ASR.

    Genuinely sparse today, on purpose -- don't pad this with options that
    don't affect anything real:

    - oMLX (`MlxSTTService`): `language_hint` maps to the `language` field
      on `/v1/audio/transcriptions` (omitted entirely -- not just left at a
      default -- when `None`, preserving today's verified-correct
      auto-detect behavior; see `MlxSTTService`'s docstring on why
      `OpenAISTTService`'s own default of `language=en` silently breaks
      non-English transcription).
    - Cloud (Deepgram): `language_hint` would map to `DeepgramSTTSettings.
      language`/`model`. Deepgram has many more real knobs (smart_format,
      profanity_filter, diarize, etc.) that aren't exposed here because
      they're not relevant to this product's bidirectional-translation use
      case -- exposing every Deepgram knob would be padding, not utility.
    """

    language_hint: str | None = None


@dataclass
class ModelSettings:
    """Top-level settings object: one section per model role."""

    llm: LlmModelSettings = field(default_factory=LlmModelSettings)
    tts: TtsModelSettings = field(default_factory=TtsModelSettings)
    stt: SttModelSettings = field(default_factory=SttModelSettings)


# --------------------------------------------------------------------------
# Load / save
# --------------------------------------------------------------------------


def _settings_path() -> Path:
    return _DEFAULT_PATH


def load_model_settings() -> ModelSettings:
    """Load `ModelSettings` from the JSON file, or return all-defaults
    (every field `None`) if the file doesn't exist or fails to parse.

    Unknown top-level keys/sections in the file are ignored (forward
    compatibility); unknown fields within a known section are also ignored
    rather than raising, so a partially-stale file from an older schema
    version degrades gracefully instead of crashing the server.
    """
    path = _settings_path()
    if not path.exists():
        return ModelSettings()

    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return ModelSettings()

    def _section(cls: type, key: str) -> Any:
        data = raw.get(key) or {}
        if not isinstance(data, dict):
            return cls()
        valid_fields = {f for f in cls.__dataclass_fields__}
        filtered = {k: v for k, v in data.items() if k in valid_fields}
        return cls(**filtered)

    return ModelSettings(
        llm=_section(LlmModelSettings, "llm"),
        tts=_section(TtsModelSettings, "tts"),
        stt=_section(SttModelSettings, "stt"),
    )


def save_model_settings(settings: ModelSettings) -> None:
    """Persist `settings` to the JSON file (pretty-printed, trailing newline).

    Always writes a full snapshot (all three sections), overwriting whatever
    was there before -- callers needing a partial update should load, merge,
    then save (see `apply_partial_update` below, used by the PUT endpoint).
    """
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = asdict(settings)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def apply_partial_update(current: ModelSettings, partial: dict[str, Any]) -> ModelSettings:
    """Merge a partial (possibly nested-partial) settings dict from a PUT
    request body over `current`, returning a new `ModelSettings`.

    `partial` may omit entire sections, or omit individual fields within a
    section -- only keys actually present are applied; everything else is
    left at `current`'s value. Unknown section/field names are ignored
    (same forward-compat posture as `load_model_settings`).
    """

    def _merge_section(cls: type, current_section: Any, updates: Any) -> Any:
        if not isinstance(updates, dict):
            return current_section
        valid_fields = {f for f in cls.__dataclass_fields__}
        merged = asdict(current_section)
        for key, value in updates.items():
            if key in valid_fields:
                merged[key] = value
        return cls(**merged)

    return ModelSettings(
        llm=_merge_section(LlmModelSettings, current.llm, partial.get("llm")),
        tts=_merge_section(TtsModelSettings, current.tts, partial.get("tts")),
        stt=_merge_section(SttModelSettings, current.stt, partial.get("stt")),
    )


# --------------------------------------------------------------------------
# Schema metadata (for the client to render appropriate controls)
# --------------------------------------------------------------------------

FieldType = Literal["text", "textarea", "number", "select"]


@dataclass
class FieldSchema:
    """Describes one tunable field for the client: enough to render the
    right control (textarea vs. slider vs. select) without hardcoding
    per-field UI knowledge into the client.
    """

    key: str
    label: str
    type: FieldType
    help: str | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[str] | None = None
    placeholder: str | None = None


def model_settings_schema() -> dict[str, Any]:
    """Schema metadata for every section/field in `ModelSettings`, grouped
    by role and (where genuinely different) by engine.

    Shape:
        {
          "llm": {"label": ..., "fields": [FieldSchema, ...]},
          "tts": {
            "label": ...,
            "engines": {
              "omlx": {"label": ..., "fields": [...]},
              "cloud": {"label": ..., "fields": [...]},
            },
          },
          "stt": {...},
        }

    The actual *values* (`ModelSettings`) are engine-agnostic at the
    storage level (one `tts.voice`/`tts.speed`/... regardless of which
    engine is active) -- the per-engine split here is purely about which
    fields are meaningful/legal to show for the currently active engine,
    since oMLX and Cartesia have genuinely different parameter vocabularies
    (the product owner's explicit ask: "render what's real, don't fabricate
    options that don't exist").
    """
    return {
        "llm": {
            "label": "LLM (Translator / Agent)",
            "help": (
                "The LLM is the brain of the pipeline. Its persona/instructions "
                "are fully replaceable -- this product isn't locked to being a "
                "translator; that's just the current configuration."
            ),
            "fields": [
                FieldSchema(
                    key="system_prompt_override",
                    label="Persona / system prompt",
                    type="textarea",
                    help=(
                        "Replaces the assistant's persona and behavior instructions. "
                        "The structural output format the pipeline depends on "
                        "(direction/tone tagging) is always preserved underneath, "
                        "regardless of what you write here. Leave empty to use the "
                        "default translator persona."
                    ),
                    placeholder="e.g. You are a warm, concise interpreter who...",
                ),
                FieldSchema(
                    key="temperature",
                    label="Temperature",
                    type="number",
                    help="Higher = more varied/creative phrasing, lower = more literal/consistent.",
                    min=0.0,
                    max=1.0,
                    step=0.05,
                ),
                FieldSchema(
                    key="top_p",
                    label="Top-p",
                    type="number",
                    help="Nucleus sampling cutoff. Leave unset to use the model's default.",
                    min=0.0,
                    max=1.0,
                    step=0.05,
                ),
            ],
        },
        "tts": {
            "label": "TTS (Voice)",
            "help": "Voice, speed, and expressiveness of the spoken output.",
            "engines": {
                "omlx": {
                    "label": "oMLX / VoxCPM2 (local dev)",
                    "fields": [
                        FieldSchema(
                            key="voice",
                            label="Voice",
                            type="select",
                            options=["default"],
                            help="VoxCPM2 currently exposes only its stock voice; voice cloning (ref_audio/ref_text) isn't wired up yet.",
                        ),
                        FieldSchema(
                            key="speed",
                            label="Speed",
                            type="number",
                            min=0.5,
                            max=2.0,
                            step=0.05,
                            help="Playback speed multiplier.",
                        ),
                        FieldSchema(
                            key="instructions_template",
                            label="Style / delivery instructions",
                            type="textarea",
                            help=(
                                "Free-text style hint sent to the model (e.g. \"speak warmly and "
                                "a little slower\"). Verified to measurably change generated audio."
                            ),
                            placeholder="e.g. calm, friendly, slightly slower than normal",
                        ),
                    ],
                },
                "cloud": {
                    "label": "Cartesia (cloud)",
                    "fields": [
                        FieldSchema(
                            key="voice",
                            label="Voice ID",
                            type="text",
                            help=(
                                "Cartesia voice_id. The default is the one verified-working voice "
                                "carried over from the prototype; swap in another voice_id from your "
                                "Cartesia account's voice library if you have one."
                            ),
                        ),
                        FieldSchema(
                            key="speed",
                            label="Speed",
                            type="number",
                            min=0.6,
                            max=1.5,
                            step=0.05,
                            help="Cartesia's generation_config.speed -- valid range 0.6-1.5.",
                        ),
                        FieldSchema(
                            key="instructions_template",
                            label="Emotion preset",
                            type="select",
                            options=[
                                "neutral", "happy", "excited", "calm", "sad", "angry",
                                "curious", "confident", "apologetic", "sarcastic",
                            ],
                            help=(
                                "Cartesia's named emotion vocabulary (60+ supported; this is a "
                                "practical subset). Per-utterance tone inference can already "
                                "override this automatically -- this sets the fallback/default."
                            ),
                        ),
                    ],
                },
            },
        },
        "stt": {
            "label": "ASR (Speech recognition)",
            "help": (
                "Genuinely little to tune here today -- both engines auto-detect "
                "the spoken language, which is what this bidirectional pipeline "
                "needs. Language hint is offered for cases where auto-detect "
                "struggles (e.g. short utterances)."
            ),
            "fields": [
                FieldSchema(
                    key="language_hint",
                    label="Language hint (optional)",
                    type="text",
                    help=(
                        "Leave empty for auto-detect (recommended -- this is a bidirectional "
                        "pipeline, so locking to one language will misdetect the other)."
                    ),
                    placeholder="e.g. zh, en (leave empty for auto-detect)",
                ),
            ],
        },
    }


def effective_settings_payload() -> dict[str, Any]:
    """Convenience for the GET endpoint: `{"schema": ..., "values": ...}`."""

    def _field_to_dict(f: FieldSchema) -> dict[str, Any]:
        return {k: v for k, v in asdict(f).items() if v is not None}

    schema = model_settings_schema()

    def _serialize_section(section: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {"label": section["label"]}
        if "help" in section:
            out["help"] = section["help"]
        if "fields" in section:
            out["fields"] = [_field_to_dict(f) for f in section["fields"]]
        if "engines" in section:
            out["engines"] = {
                engine_key: {
                    "label": engine_section["label"],
                    "fields": [_field_to_dict(f) for f in engine_section["fields"]],
                }
                for engine_key, engine_section in section["engines"].items()
            }
        return out

    serialized_schema = {key: _serialize_section(section) for key, section in schema.items()}

    return {
        "schema": serialized_schema,
        "values": asdict(load_model_settings()),
    }
