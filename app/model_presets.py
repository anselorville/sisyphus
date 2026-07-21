"""Persisted, named presets for model parameter tuning (the Preset System).

This module is the storage/CRUD half of the Preset feature, complementing the
schema-based Model Lab in app/model_settings.py and app/model_adapters/.

A preset is a named bundle of field values for a specific capability (text/speech),
allowing users to quickly switch between tuning profiles without re-entering
parameters manually. Presets are organized by capability rather than adapter,
enabling reuse across multiple adapters with compatible fields (e.g., a "casual"
persona preset works equally well for cloud:text and omlx:qwen3_5).

Storage shape:
    {
      "text": [
        {"id": "builtin:text:default", "name": "默认翻译专家", "builtin": true, "values": {}},
        {"id": "p_abc123", "name": "旅行翻译官", "builtin": false, "values": {"system_prompt_override": "..."}},
        ...
      ],
      "speech": [
        {"id": "builtin:speech:default", "name": "默认", "builtin": true, "values": {}},
        ...
      ]
    }

Builtin presets (builtin=True) are code constants, never persisted to disk, and
cannot be modified or deleted. User presets (builtin=False) are persisted to
`model_presets.json` at the repo root (gitignored).

Like app/model_settings.py, this module adopts a forward-compat posture: unknown
capabilities or preset fields are preserved as-is, never dropped. Corrupt or
missing JSON files gracefully degrade to empty user-preset store.

Storage path can be overridden via MODEL_PRESETS_PATH env var for tests.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

# Repo-root JSON file. Same conceptual tier as .env: runtime-local, optional,
# gitignored. Overridable via MODEL_PRESETS_PATH for tests.
# NOTE: Unlike model_settings.py, we read the env var at CALL TIME (inside
# _presets_path()) rather than at MODULE IMPORT TIME (_DEFAULT_PATH).
# This allows tests to use monkeypatch.setenv() without needing to reload the
# module or use pytest fixtures to override a module-level constant.
_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "model_presets.json"


class BuiltinPresetError(Exception):
    """Raised when attempting to modify or delete a builtin preset."""

    pass


class PresetNotFoundError(Exception):
    """Raised when attempting to update/delete a preset that doesn't exist."""

    pass


# The full on-disk shape: {capability: [preset, ...], ...}
PresetsStore = dict[str, list[dict[str, Any]]]


def _presets_path() -> Path:
    """Return the path to the presets JSON file, reading MODEL_PRESETS_PATH
    env var at call time (not import time). This allows tests to monkeypatch
    the env without requiring module reloads.
    """
    return Path(os.environ.get("MODEL_PRESETS_PATH", _DEFAULT_PATH))


# Builtin presets for the "text" capability -- same system_prompt_override
# values as documented in the design spec.
_TEXT_BUILTINS: list[dict[str, Any]] = [
    {
        "id": "builtin:text:default",
        "name": "默认翻译专家",
        "builtin": True,
        "values": {},
    },
    {
        "id": "builtin:text:simultaneous",
        "name": "同声传译（极简直译）",
        "builtin": True,
        "values": {
            "system_prompt_override": (
                "You are a professional simultaneous interpreter. Translate as literally and concisely "
                "as possible, preserving the speaker's exact meaning, register, and terminology. "
                "Never add, soften, or expand anything."
            )
        },
    },
    {
        "id": "builtin:text:casual",
        "name": "口语化意译",
        "builtin": True,
        "values": {
            "system_prompt_override": (
                "You are a casual, natural-sounding interpreter. Translate meaning-for-meaning into "
                "everyday conversational language, prioritizing how a native speaker would actually say it "
                "over literal wording."
            )
        },
    },
    {
        "id": "builtin:text:business",
        "name": "商务正式",
        "builtin": True,
        "values": {
            "system_prompt_override": (
                "You are a professional business interpreter. Translate into polished, formal business "
                "language, preserving titles and honorifics, and softening bluntness into professional "
                "courtesy where natural."
            )
        },
    },
    {
        "id": "builtin:text:kids",
        "name": "儿童友好",
        "builtin": True,
        "values": {
            "system_prompt_override": (
                "You are a friendly interpreter for conversations with children. Translate into simple, "
                "warm, easy words a young child understands, keeping sentences short."
            )
        },
    },
]

# Builtin presets for the "speech" capability -- delivery persona / style.
_SPEECH_BUILTINS: list[dict[str, Any]] = [
    {
        "id": "builtin:speech:default",
        "name": "默认",
        "builtin": True,
        "values": {},
    },
    {
        "id": "builtin:speech:warm",
        "name": "温柔舒缓",
        "builtin": True,
        "values": {
            "instructions": "speak softly and warmly, at a relaxed, soothing pace",
            "speed": 0.9,
        },
    },
    {
        "id": "builtin:speech:news",
        "name": "新闻播报",
        "builtin": True,
        "values": {
            "instructions": "speak clearly and crisply, like a professional news anchor, with confident, even pacing",
        },
    },
    {
        "id": "builtin:speech:fast",
        "name": "快速简洁",
        "builtin": True,
        "values": {
            "instructions": "speak briskly and efficiently, no dramatic pauses",
            "speed": 1.2,
        },
    },
    {
        "id": "builtin:speech:lively",
        "name": "热情活泼",
        "builtin": True,
        "values": {
            "instructions": "speak with lively enthusiasm and bright, upbeat energy",
        },
    },
]

# Full builtin preset map, keyed by capability.
BUILTIN_PRESETS: dict[str, list[dict[str, Any]]] = {
    "text": _TEXT_BUILTINS,
    "speech": _SPEECH_BUILTINS,
}


def load_presets() -> PresetsStore:
    """Load the full `{capability: [preset, ...]}` store from the JSON file,
    or return `{"text": [], "speech": []}` (no user presets) if the file
    doesn't exist or fails to parse.

    Forward-compat: any top-level value that isn't itself a list is dropped
    (each capability's value must be a list of preset dicts); everything else
    is preserved as-is, including presets this version doesn't otherwise
    recognize -- validating them against real schemas is the caller's job.
    """
    path = _presets_path()
    if not path.exists():
        return {"text": [], "speech": []}

    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {"text": [], "speech": []}

    if not isinstance(raw, dict):
        return {"text": [], "speech": []}

    store: PresetsStore = {}
    for capability, presets in raw.items():
        if isinstance(capability, str) and isinstance(presets, list):
            # Preserve each preset as-is; don't validate individual fields.
            store[capability] = presets
        # Skip malformed entries, don't raise or wipe the whole store.

    return store


def save_presets(store: PresetsStore) -> None:
    """Persist `store` to the JSON file (pretty-printed, trailing newline).

    Always writes a full snapshot, overwriting whatever was there before --
    callers needing a partial update should load, merge, then save.
    """
    path = _presets_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store, indent=2) + "\n")


def _validate_capability(capability: str) -> None:
    """Raise ValueError if capability is not 'text' or 'speech'."""
    if capability not in ("text", "speech"):
        raise ValueError(f"Invalid capability {capability!r} (must be 'text' or 'speech')")


def list_presets(capability: str) -> list[dict[str, Any]]:
    """List all presets for a given capability (builtin + user presets).

    Builtins are returned first, then user presets from disk (in the order
    they appear in the JSON file). For unknown capabilities, returns only
    the builtins for that capability (empty list if no builtins exist).

    Args:
        capability: Either "text" or "speech". Other values raise ValueError.

    Returns:
        List of preset dicts, each with {"id", "name", "builtin", "values"}.
    """
    _validate_capability(capability)

    builtins = BUILTIN_PRESETS.get(capability, [])
    user_store = load_presets()
    user_presets = user_store.get(capability, [])

    # Return builtins first, then user presets.
    return [dict(p) for p in builtins] + [dict(p) for p in user_presets]


def create_preset(capability: str, name: str, values: dict[str, Any]) -> dict[str, Any]:
    """Create a new user preset and persist it.

    Args:
        capability: Either "text" or "speech". Raises ValueError otherwise.
        name: Display name for the preset (non-empty string).
        values: Dict of field overrides for this preset.

    Returns:
        The newly created preset dict: {"id", "name", "builtin": false, "values"}.

    Raises:
        ValueError: If capability is invalid or name is empty.
    """
    _validate_capability(capability)
    if not name or not isinstance(name, str):
        raise ValueError("Preset name must be a non-empty string")
    if not isinstance(values, dict):
        raise ValueError("Preset values must be a dict")

    preset_id = "p_" + uuid.uuid4().hex[:8]
    preset = {
        "id": preset_id,
        "name": name,
        "builtin": False,
        "values": dict(values),
    }

    store = load_presets()
    if capability not in store:
        store[capability] = []
    store[capability].append(preset)
    save_presets(store)

    return dict(preset)


def update_preset(preset_id: str, name: str | None = None, values: dict[str, Any] | None = None) -> dict[str, Any]:
    """Update an existing user preset.

    Args:
        preset_id: The preset's ID.
        name: New display name (if provided).
        values: New field overrides (if provided); a dict.

    Returns:
        The updated preset dict.

    Raises:
        BuiltinPresetError: If the preset is builtin.
        PresetNotFoundError: If no preset with that ID exists.
        ValueError: If name is empty or values is not a dict.
    """
    if preset_id.startswith("builtin:"):
        raise BuiltinPresetError(f"Cannot modify builtin preset {preset_id!r}")

    store = load_presets()
    found_capability = None
    found_index = None

    # Search all capabilities for the preset.
    for capability, presets in store.items():
        for i, preset in enumerate(presets):
            if preset.get("id") == preset_id:
                found_capability = capability
                found_index = i
                break
        if found_capability:
            break

    if found_capability is None or found_index is None:
        raise PresetNotFoundError(f"Preset {preset_id!r} not found")

    preset = store[found_capability][found_index]

    # Validate builtin status (sanity check; should never happen in normal flow).
    if preset.get("builtin"):
        raise BuiltinPresetError(f"Cannot modify builtin preset {preset_id!r}")

    if name is not None:
        if not name or not isinstance(name, str):
            raise ValueError("Preset name must be a non-empty string")
        preset["name"] = name

    if values is not None:
        if not isinstance(values, dict):
            raise ValueError("Preset values must be a dict")
        preset["values"] = dict(values)

    save_presets(store)
    return dict(preset)


def delete_preset(preset_id: str) -> None:
    """Delete an existing user preset.

    Args:
        preset_id: The preset's ID.

    Raises:
        BuiltinPresetError: If the preset is builtin.
        PresetNotFoundError: If no preset with that ID exists.
    """
    if preset_id.startswith("builtin:"):
        raise BuiltinPresetError(f"Cannot delete builtin preset {preset_id!r}")

    store = load_presets()
    found_capability = None
    found_index = None

    # Search all capabilities for the preset.
    for capability, presets in store.items():
        for i, preset in enumerate(presets):
            if preset.get("id") == preset_id:
                found_capability = capability
                found_index = i
                break
        if found_capability:
            break

    if found_capability is None or found_index is None:
        raise PresetNotFoundError(f"Preset {preset_id!r} not found")

    preset = store[found_capability][found_index]

    # Validate builtin status (sanity check; should never happen in normal flow).
    if preset.get("builtin"):
        raise BuiltinPresetError(f"Cannot delete builtin preset {preset_id!r}")

    store[found_capability].pop(found_index)
    save_presets(store)
