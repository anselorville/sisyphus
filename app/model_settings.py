"""Persisted, user-tunable model-parameter overrides (the "Model Lab").

This module is the VALUES/storage half of the Model Lab feature; the
SCHEMA half (what fields exist to tune, per adapter) lives in
app/model_adapters/. The two compose: app/server.py's `/api/model-lab/*`
endpoints call into app/model_adapters.list_adapters()/get_adapter() for
"what can be tuned" and into this module's load/save/apply_partial_update
for "what has been set".

Storage shape is intentionally generic -- one JSON object keyed by adapter
id (`"cloud:text"`, `"omlx:qwen3_5"`, etc., see app/model_adapters/'s module
docstring for the adapter-id convention), each value an arbitrary
`{field_key: value}` dict matching that adapter's declared fields:

    {
      "cloud:text": {"temperature": 0.4, "system_prompt_override": "..."},
      "omlx:qwen3_5": {"temperature": 0.2, "enable_thinking": false},
      "omlx:voxcpm2": {"speed": 1.1, "instructions": "calm and warm"},
      ...
    }

This replaces the previous fixed `ModelSettings(llm=..., tts=..., stt=...)`
dataclass shape (one hardcoded section per pipeline role) with a shape that
scales to "every local model architecture gets its own tuning profile,
declared as a config file" without this module needing to know what fields
any particular adapter has -- it's just a `dict[str, dict[str, Any]]` store.

Carried over from the previous design (these properties were good and are
kept on purpose):
- Persistence: a single flat JSON file, `model_settings.json`, at the repo
  root (see `_DEFAULT_PATH`). Same tier as `.env`/`models/` -- runtime-local
  state, gitignored, never committed.
- Partial-update merge: `apply_partial_update` only touches the adapter_id
  section(s) actually present in a PUT body, leaving every other adapter's
  saved values untouched.
- Forward-compat on unknown keys: an adapter id or field key this version of
  the code doesn't recognize is preserved as-is rather than dropped or
  raised on -- a value store has no schema validation of its own (unlike the
  old dataclass-based design); app/model_adapters.AdapterSpec is what
  decides which fields are meaningful to apply/render, this module just
  stores whatever it's given.

Nothing in this module changes pipeline behavior by itself: app/pipeline.py
reads from `load_model_settings()`/`values_for()` to pull adapter-specific
overrides into the actual service-construction calls (temperature/top_p/
voice/speed/instructions/system_prompt_override/enable_thinking/etc.,
depending on which adapter applies) -- see that module's `_build_cloud_*`/
`_build_mlx_service_trio` functions for the wiring.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

# Repo-root JSON file. Same conceptual tier as .env: runtime-local, optional,
# gitignored. Overridable via MODEL_SETTINGS_PATH for tests/tooling.
_DEFAULT_PATH = Path(
    os.environ.get("MODEL_SETTINGS_PATH", Path(__file__).resolve().parent.parent / "model_settings.json")
)

# The full on-disk shape: {adapter_id: {field_key: value, ...}, ...}.
ModelLabValues = dict[str, dict[str, Any]]


def _settings_path() -> Path:
    return _DEFAULT_PATH


def load_model_settings() -> ModelLabValues:
    """Load the full `{adapter_id: {field_key: value}}` store from the JSON
    file, or return `{}` (all-defaults -- every adapter's values "unset") if
    the file doesn't exist or fails to parse.

    Forward-compat: any top-level value that isn't itself a dict is dropped
    (an adapter section must be an object of field values); everything else
    is preserved as-is, including adapter ids / field keys this version of
    the code doesn't otherwise recognize -- validating those against real
    `AdapterSpec`s is the caller's job (see app/model_adapters.py), not this
    storage layer's.
    """
    path = _settings_path()
    if not path.exists():
        return {}

    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}

    if not isinstance(raw, dict):
        return {}

    return {
        adapter_id: dict(values)
        for adapter_id, values in raw.items()
        if isinstance(adapter_id, str) and isinstance(values, dict)
    }


def save_model_settings(values: ModelLabValues) -> None:
    """Persist `values` to the JSON file (pretty-printed, trailing newline).

    Always writes a full snapshot, overwriting whatever was there before --
    callers needing a partial update should load, merge, then save (see
    `apply_partial_update` below, used by the PUT endpoint).
    """
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(values, indent=2) + "\n")


def apply_partial_update(current: ModelLabValues, partial: dict[str, Any]) -> ModelLabValues:
    """Merge a partial `{adapter_id: {field_key: value}}` dict over
    `current`, returning a new store.

    `partial` may include only some adapter ids, and within each adapter id
    only some field keys -- only keys actually present are applied; every
    other adapter's values, and every field not mentioned within a touched
    adapter, are left exactly as they were. This is a shallow per-adapter
    merge (field-level merge within an adapter id, not a deep recursive
    merge) -- matches the field-flat shape every `AdapterSpec`'s fields
    actually have.
    """
    merged: ModelLabValues = {adapter_id: dict(values) for adapter_id, values in current.items()}
    if not isinstance(partial, dict):
        return merged

    for adapter_id, updates in partial.items():
        if not isinstance(adapter_id, str) or not isinstance(updates, dict):
            continue
        section = dict(merged.get(adapter_id, {}))
        section.update(updates)
        merged[adapter_id] = section

    return merged


def values_for(adapter_id: str, store: ModelLabValues | None = None) -> dict[str, Any]:
    """Convenience accessor: the saved `{field_key: value}` dict for one
    adapter id, or `{}` if nothing has been saved for it yet.

    `store` defaults to a fresh `load_model_settings()` call if not given --
    pass an already-loaded store when fetching values for several adapter
    ids at once (e.g. building all three pipeline services) to avoid
    re-reading the file repeatedly.
    """
    if store is None:
        store = load_model_settings()
    return dict(store.get(adapter_id, {}))
