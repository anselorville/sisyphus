"""Runnable entrypoint for the Sisyphus speech translator.

Starts a FastAPI app that:
- Serves the minimal browser client (app/static/index.html) at "/".
- Handles WebRTC SDP offer/answer signaling at POST /api/offer.
- Spins up a Pipecat translation pipeline per WebRTC connection.

Run with:

    python -m app.server

or, after `uv sync`:

    uv run python -m app.server
"""

from __future__ import annotations

import asyncio
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

import json as json_module

import httpx
import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from loguru import logger
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.workers.runner import WorkerRunner

from app.config import Settings, load_settings
from app.model_providers import (
    apply_partial_update as apply_providers_partial_update,
    effective_providers_payload,
    load_model_providers,
    save_model_providers,
)
from app.model_adapters import Capability, list_adapters_async
from app.model_lab_preview import PreviewError, preview_chain, preview_speech, preview_text, preview_transcription
from app.model_presets import (
    BuiltinPresetError,
    PresetNotFoundError,
    create_preset,
    delete_preset,
    list_presets,
    update_preset,
)
from app.voice_library import (
    VoiceExistsError,
    VoiceNotFoundError,
    VoiceValidationError,
    create_voice,
    delete_voice,
    list_voices,
)
from app.model_settings import (
    apply_partial_update,
    load_model_settings,
    save_model_settings,
)
from app.pipeline import build_pipeline_worker, select_engine

STATIC_DIR = Path(__file__).parent / "static"

# Public STUN server for local/dev NAT traversal. Good enough for a single
# developer testing over a LAN or localhost; swap in your own ICE servers for
# production deployments behind restrictive NATs.
ICE_SERVERS = ["stun:stun.l.google.com:19302"]

# Connections keyed by pc_id, so renegotiation (e.g. ICE restarts) reuses the
# existing peer connection instead of spinning up a duplicate pipeline.
pcs_map: dict[str, SmallWebRTCConnection] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    coros = [pc.disconnect() for pc in pcs_map.values()]
    await asyncio.gather(*coros, return_exceptions=True)
    pcs_map.clear()


app = FastAPI(lifespan=lifespan)
# The client is always a separate process/origin from this server (Tauri
# webview or Vite dev server talking to the Python backend over HTTP), never
# same-origin, so CORS must be open for the API to be reachable at all.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # Custom response headers are invisible to cross-origin JS unless
    # explicitly exposed -- the client reads the preview timing headers
    # (X-Preview-Total-Ms/X-Preview-Audio-Ms) from fetch() responses.
    expose_headers=["X-Preview-Total-Ms", "X-Preview-Audio-Ms"],
)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Resolved once at import/startup time, mirroring how `select_engine()` is
# documented to behave for the pipeline itself (selection happens once, for
# the lifetime of the process -- no mid-run re-checking). This avoids
# re-probing connectivity (the `ENGINE=auto` case) on every `/api/status`
# request; it does mean a status change (e.g. internet coming back online
# after startup) requires a server restart to be reflected, which matches
# the pipeline's own behavior.
_startup_settings = load_settings()
_resolved_engine = select_engine(_startup_settings)


@app.get("/", include_in_schema=False)
async def index():
    from fastapi.responses import FileResponse

    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
async def status() -> dict[str, str]:
    """Report the resolved translation engine and configured language pair.

    The engine is resolved once at server startup (see `_resolved_engine`
    above) via the same `select_engine()` used by the pipeline itself, so
    this always reflects what connections will actually get -- never
    duplicated/re-implemented selection logic.
    """
    return {
        "engine": _resolved_engine,
        "source_lang": _startup_settings.source_lang,
        "target_lang": _startup_settings.target_lang,
    }


# Role labels for the 3 oMLX models this app cares about, keyed by their
# configured model id (see Settings.omlx_llm_model/omlx_stt_model/
# omlx_tts_model) -- used to shape the /api/local-engine/* responses.
def _local_engine_roles(settings: Settings) -> dict[str, str]:
    return {
        settings.omlx_llm_model: "llm",
        settings.omlx_stt_model: "stt",
        settings.omlx_tts_model: "tts",
    }


def _require_omlx_configured(settings: Settings) -> None:
    """Raise a 400 if oMLX isn't configured, rather than attempting a
    request against an empty base_url. This matters because these endpoints
    are reachable regardless of the currently-selected ENGINE -- a user on
    ENGINE=cloud may have no oMLX config at all.
    """
    if not settings.omlx_base_url or not settings.omlx_api_key:
        raise HTTPException(
            status_code=400,
            detail="oMLX is not configured (OMLX_BASE_URL/OMLX_API_KEY) -- "
            "local model management is unavailable.",
        )


async def _fetch_local_engine_status(settings: Settings) -> dict:
    """Query oMLX's GET /v1/models/status and filter down to our 3 configured
    model ids, tagging each with its role (llm/stt/tts).

    Returns `{"available": True, "models": [{"id", "role", "loaded"}, ...]}`
    on success. If oMLX is unreachable (not running, wrong URL, etc.), returns
    `{"available": False, "models": [{"id", "role", "loaded": None}, ...]}`
    rather than raising -- the server being down is an expected, recoverable
    state (e.g. a user on ENGINE=cloud who never started oMLX at all).
    """
    roles = _local_engine_roles(settings)
    try:
        async with httpx.AsyncClient(
            base_url=settings.omlx_base_url,
            headers={"Authorization": f"Bearer {settings.omlx_api_key}"},
            timeout=10.0,
        ) as client:
            response = await client.get("/models/status")
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPError as exc:
        logger.warning(f"oMLX status check failed (server unreachable?): {exc}")
        return {
            "available": False,
            "models": [{"id": model_id, "role": role, "loaded": None} for model_id, role in roles.items()],
        }

    by_id = {model["id"]: model for model in data.get("models", [])}
    return {
        "available": True,
        "models": [
            {
                "id": model_id,
                "role": role,
                "loaded": bool(by_id[model_id]["loaded"]) if model_id in by_id else None,
            }
            for model_id, role in roles.items()
        ],
    }


async def _set_local_engine_loaded(settings: Settings, *, loaded: bool) -> dict:
    """POST load (loaded=True) or unload (loaded=False) for each of our 3
    configured oMLX model ids, sequentially (loads can take several seconds
    each and there's no existing job/polling infrastructure in this codebase
    to make concurrency worth the complexity), then return the resulting
    status in the same shape as `_fetch_local_engine_status`.
    """
    _require_omlx_configured(settings)
    roles = _local_engine_roles(settings)
    action = "load" if loaded else "unload"
    async with httpx.AsyncClient(
        base_url=settings.omlx_base_url,
        headers={"Authorization": f"Bearer {settings.omlx_api_key}"},
        timeout=60.0,
    ) as client:
        for model_id in roles:
            try:
                response = await client.post(f"/models/{model_id}/{action}")
                response.raise_for_status()
            except httpx.HTTPError as exc:
                logger.error(f"oMLX {action} failed for {model_id}: {exc}")
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to {action} oMLX model {model_id!r}: {exc}",
                ) from exc

    return await _fetch_local_engine_status(settings)


@app.get("/api/local-engine/status")
async def local_engine_status() -> dict:
    """Report load state of the 3 configured oMLX models (LLM/STT/TTS).

    Works regardless of the currently-selected ENGINE. If oMLX itself isn't
    configured (empty OMLX_BASE_URL/OMLX_API_KEY), `available` is False and
    every model's `loaded` is null; same if oMLX is configured but
    unreachable (server not running).
    """
    settings = load_settings()
    if not settings.omlx_base_url or not settings.omlx_api_key:
        roles = _local_engine_roles(settings)
        return {
            "available": False,
            "models": [{"id": model_id, "role": role, "loaded": None} for model_id, role in roles.items()],
        }
    return await _fetch_local_engine_status(settings)


@app.post("/api/local-engine/start")
async def local_engine_start() -> dict:
    """Load all 3 configured oMLX models (sequential POST .../load each).

    Raises 400 if oMLX isn't configured, 502 if any individual load fails.
    """
    settings = load_settings()
    return await _set_local_engine_loaded(settings, loaded=True)


@app.post("/api/local-engine/stop")
async def local_engine_stop() -> dict:
    """Unload all 3 configured oMLX models (sequential POST .../unload each).

    Raises 400 if oMLX isn't configured, 502 if any individual unload fails.
    """
    settings = load_settings()
    return await _set_local_engine_loaded(settings, loaded=False)


_CAPABILITIES: tuple[Capability, ...] = ("text", "speech", "transcription")


@app.get("/api/model-lab/schema")
async def get_model_lab_schema() -> dict:
    """Return every tunable adapter, grouped by capability:

        {
          "text": {"adapters": [AdapterSpec, ...]},
          "speech": {"adapters": [...]},
          "transcription": {"adapters": [...]},
        }

    Each capability's adapter list always has exactly one `cloud:<capability>`
    entry (the shared cloud parameter table) plus the local adapter matching
    whichever oMLX model is currently configured for that capability --
    either a real spec-file match (keyed by oMLX's `config_model_type`, see
    app/model_adapters/'s module docstring) or an "unrecognized model, no
    tuning profile yet" stub with no fields, never an error.
    """
    settings = load_settings()
    return {
        capability: {"adapters": [a.to_dict() for a in await list_adapters_async(capability, settings)]}
        for capability in _CAPABILITIES
    }


@app.get("/api/model-lab/values")
async def get_model_lab_values() -> dict:
    """Return the full persisted Model Lab value store:
    `{"<adapter_id>": {<field_key>: <value>, ...}, ...}`.
    """
    return load_model_settings()


@app.put("/api/model-lab/values")
async def put_model_lab_values(request: dict) -> dict:
    """Accept a partial `{"<adapter_id>": {...fields...}, ...}` update,
    merge it over the persisted store (only the adapter id(s)/field(s)
    actually present in the body are touched -- see
    `app.model_settings.apply_partial_update`), persist it, and return the
    new full value store in the same shape as GET.
    """
    current = load_model_settings()
    updated = apply_partial_update(current, request)
    save_model_settings(updated)
    return updated


@app.post("/api/model-lab/preview/text")
async def post_model_lab_preview_text(request: dict) -> dict:
    """Run one real LLM call against the configured service for
    `request["adapter_id"]` (`cloud:text` -> whatever provider is currently
    configured for the text capability; `omlx:<config_model_type>` -> the
    matching oMLX builder), with `request["values"]` applied as draft
    overrides on top of (not replacing) the currently-saved values for that
    adapter.

    Body: `{"adapter_id": str, "values": {...draft field overrides...},
    "input_text": str}`. Returns `{"output_text": str, "timing": {"total_ms": int}}`.

    Uses a short, generic test system prompt -- NOT the full bidirectional
    translation system prompt -- unless `values.system_prompt_override` (or
    a previously-saved one) is set, in which case that exact persona text is
    used verbatim as the system instruction (see
    `app.model_lab_preview.preview_text`'s docstring for why).
    """
    adapter_id = request.get("adapter_id")
    values = request.get("values") or {}
    input_text = request.get("input_text") or ""
    if not isinstance(adapter_id, str) or not adapter_id:
        raise HTTPException(status_code=400, detail="'adapter_id' is required.")
    if not isinstance(values, dict):
        raise HTTPException(status_code=400, detail="'values' must be an object.")

    settings = load_settings()
    try:
        output_text, timing = await preview_text(
            adapter_id=adapter_id, values=values, input_text=input_text, settings=settings
        )
    except PreviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        # Missing API key / unconfigured provider, etc. -- same class of
        # error app/pipeline.py's own builders raise at pipeline-build time.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"output_text": output_text, "timing": timing}


@app.post("/api/model-lab/preview/speech")
async def post_model_lab_preview_speech(request: dict):
    """Run one real TTS call against the configured service for
    `request["adapter_id"]`, with `request["values"]` applied as draft
    overrides on top of the currently-saved values for that adapter.

    Body: `{"adapter_id": str, "values": {...}, "input_text": str}`.
    Returns a real WAV file (`Content-Type: audio/wav`) -- the concatenated
    `TTSAudioRawFrame.audio` bytes from one real `run_test()` call, wrapped
    in a WAV header built from the frames' own sample_rate/num_channels (see
    `app.model_lab_preview._wav_bytes_from_frames`). Response headers include
    `X-Preview-Total-Ms` and `X-Preview-Audio-Ms` with timing metadata.
    """
    adapter_id = request.get("adapter_id")
    values = request.get("values") or {}
    input_text = request.get("input_text") or ""
    if not isinstance(adapter_id, str) or not adapter_id:
        raise HTTPException(status_code=400, detail="'adapter_id' is required.")
    if not isinstance(values, dict):
        raise HTTPException(status_code=400, detail="'values' must be an object.")

    settings = load_settings()
    try:
        wav_bytes, timing = await preview_speech(
            adapter_id=adapter_id, values=values, input_text=input_text, settings=settings
        )
    except PreviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Preview-Total-Ms": str(timing["total_ms"]),
            "X-Preview-Audio-Ms": str(timing["audio_ms"]),
        },
    )


@app.post("/api/model-lab/preview/transcription")
async def post_model_lab_preview_transcription(
    adapter_id: str = Form(...),
    values: str = Form("{}"),
    audio: UploadFile = File(...),
) -> dict:
    """Run one real STT call against the configured service for
    `adapter_id`, with `values` (a JSON-encoded string field) applied as
    draft overrides on top of the currently-saved values for that adapter.

    Multipart form fields: `adapter_id` (str), `values` (JSON-encoded
    object, as a string field), `audio` (file upload). The uploaded file
    must be a WAV (16-bit PCM) -- its actual sample rate/channel count are
    read from its own header (via Python's `wave` module) rather than
    assumed, so any sample rate works, but non-WAV containers are rejected
    with a 400.

    Returns `{"transcript": str, "timing": {"total_ms": int}}`.
    """
    try:
        parsed_values = json_module.loads(values) if values else {}
    except json_module.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"'values' is not valid JSON: {exc}") from exc
    if not isinstance(parsed_values, dict):
        raise HTTPException(status_code=400, detail="'values' must decode to a JSON object.")

    audio_bytes = await audio.read()
    settings = load_settings()
    try:
        transcript, timing = await preview_transcription(
            adapter_id=adapter_id, values=parsed_values, audio_wav_bytes=audio_bytes, settings=settings
        )
    except PreviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"transcript": transcript, "timing": timing}


# One-shot audio stash for chain preview endpoint.
# Maps token -> bytes. Capped at 8 entries; evicts oldest when full.
# This prevents abandoned tokens from growing memory unboundedly.
_chain_audio_stash: dict[str, bytes] = {}


def _stash_chain_audio(audio_bytes: bytes) -> str:
    """Store audio bytes and return a one-time token to retrieve them.
    Evicts oldest entry if stash is at capacity (8 entries)."""
    if len(_chain_audio_stash) >= 8:
        # Remove the oldest (first inserted) entry.
        # dict preserves insertion order in Python 3.7+.
        oldest_token = next(iter(_chain_audio_stash))
        del _chain_audio_stash[oldest_token]
    token = secrets.token_urlsafe(16)
    _chain_audio_stash[token] = audio_bytes
    return token


def _pop_chain_audio(token: str) -> bytes | None:
    """Retrieve and delete audio by token. Returns None if token not found."""
    return _chain_audio_stash.pop(token, None)


@app.post("/api/model-lab/preview/chain")
async def post_model_lab_preview_chain(
    stt_adapter_id: str = Form(...),
    llm_adapter_id: str = Form(...),
    tts_adapter_id: str = Form(...),
    values: str = Form("{}"),
    audio: UploadFile = File(...),
) -> dict:
    """Run a full chain preview: STT → LLM (with real translation prompt +
    persona override) → TTS. Returns text results + per-stage timing + audio token.

    Multipart form fields: `stt_adapter_id`, `llm_adapter_id`, `tts_adapter_id` (str),
    `values` (JSON-encoded dict keyed by adapter_id, as a string field),
    `audio` (WAV file upload, 16-bit PCM).

    Returns `{"transcript": str, "translated_text": str, "direction": str|null,
    "tone": str|null, "timing": {...}, "audio_token": str}`.
    Audio bytes are stored one-shot; retrieve via GET /api/model-lab/preview/chain/audio/{token}.

    Raises 400 if JSON parse fails, adapters are invalid, or any stage fails
    (empty transcript, no translation, etc.).
    """
    try:
        parsed_values = json_module.loads(values) if values else {}
    except json_module.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"'values' is not valid JSON: {exc}") from exc
    if not isinstance(parsed_values, dict):
        raise HTTPException(status_code=400, detail="'values' must decode to a JSON object.")

    audio_bytes = await audio.read()
    settings = load_settings()
    try:
        result_dict, wav_bytes = await preview_chain(
            stt_adapter_id=stt_adapter_id,
            llm_adapter_id=llm_adapter_id,
            tts_adapter_id=tts_adapter_id,
            values=parsed_values,
            audio_wav_bytes=audio_bytes,
            settings=settings,
        )
    except PreviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    audio_token = _stash_chain_audio(wav_bytes)
    result_dict["audio_token"] = audio_token
    return result_dict


@app.get("/api/model-lab/preview/chain/audio/{token}")
async def get_model_lab_preview_chain_audio(token: str):
    """Retrieve and delete the audio WAV for a chain preview.

    Path param: `token` (the audio_token returned by POST /api/model-lab/preview/chain).

    Returns: 200 with audio/wav if found; 404 if token not found or already fetched.
    """
    wav_bytes = _pop_chain_audio(token)
    if not wav_bytes:
        raise HTTPException(status_code=404, detail="Audio token not found or already fetched.")
    return Response(content=wav_bytes, media_type="audio/wav")


@app.get("/api/model-lab/presets")
async def get_model_lab_presets(capability: str = "") -> dict:
    """Return all presets (builtin + user) for a given capability.

    Query param: `capability` (required) -- either "text" or "speech".

    Returns `{"presets": [...]}` where each preset is
    `{"id", "name", "builtin", "values"}`. Builtins are listed first.

    Raises 400 if `capability` is invalid.
    """
    if not capability or capability not in ("text", "speech"):
        raise HTTPException(
            status_code=400,
            detail="'capability' query param is required and must be 'text' or 'speech'",
        )

    try:
        presets = list_presets(capability)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"presets": presets}


@app.post("/api/model-lab/presets")
async def post_model_lab_presets(request: dict) -> dict:
    """Create a new user preset.

    Body: `{"capability": "text"|"speech", "name": str, "values": {...}}`.
    Returns the newly created preset (status 201).

    Raises 400 if capability is invalid, name is empty, or values is not a dict.
    """
    capability = request.get("capability")
    name = request.get("name")
    values = request.get("values")

    if not capability or capability not in ("text", "speech"):
        raise HTTPException(
            status_code=400,
            detail="'capability' is required and must be 'text' or 'speech'",
        )
    if not name or not isinstance(name, str):
        raise HTTPException(status_code=400, detail="'name' must be a non-empty string")
    if not isinstance(values, dict):
        raise HTTPException(status_code=400, detail="'values' must be a JSON object")

    try:
        preset = create_preset(capability, name, values)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    from fastapi.responses import JSONResponse

    return JSONResponse(content=preset, status_code=201)


@app.put("/api/model-lab/presets/{preset_id}")
async def put_model_lab_presets(preset_id: str, request: dict) -> dict:
    """Update an existing user preset.

    Path param: `preset_id` (the preset's ID).
    Body: `{"name"?: str, "values"?: {...}}` (both optional, but at least one must be provided).

    Returns the updated preset.

    Raises 400 if preset is builtin, 404 if not found.
    """
    name = request.get("name")
    values = request.get("values")

    # Allow either name or values (or both) to be provided.
    if name is None and values is None:
        raise HTTPException(
            status_code=400,
            detail="Request body must include at least one of 'name' or 'values'",
        )

    try:
        preset = update_preset(preset_id, name=name, values=values)
    except BuiltinPresetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PresetNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return preset


@app.delete("/api/model-lab/presets/{preset_id}")
async def delete_model_lab_presets(preset_id: str) -> dict:
    """Delete an existing user preset.

    Path param: `preset_id` (the preset's ID).

    Returns `{"ok": true}` on success.

    Raises 400 if preset is builtin, 404 if not found.
    """
    try:
        delete_preset(preset_id)
    except BuiltinPresetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PresetNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {"ok": True}


@app.get("/api/model-lab/voices")
async def get_model_lab_voices() -> dict:
    """Return all available voices in the library.

    Returns `{"voices": [...]}` where each voice is
    `{"id", "name", "language", "created_at"}`.
    """
    voices = list_voices()
    return {"voices": voices}


@app.post("/api/model-lab/voices")
async def post_model_lab_voices(
    name: str = Form(None),
    ref_text: str = Form(None),
    audio: UploadFile = File(...),
    language: str = Form(None),
) -> dict:
    """Create a new voice in the library.

    Multipart form fields: `name` (str), `ref_text` (str), `audio` (WAV file),
    optional `language` (str, e.g. "zh", "en").

    The uploaded file must be a WAV (16-bit PCM, 1-30 seconds).

    Returns the newly created voice (status 201).

    Raises 400 if validation fails (bad audio, empty name/ref_text, name not sanitizable,
    duplicate name, or audio duration outside 1-30 seconds).
    """
    if not name:
        raise HTTPException(status_code=400, detail="'name' is required and must be non-empty.")
    if not ref_text:
        raise HTTPException(status_code=400, detail="'ref_text' is required and must be non-empty.")

    audio_bytes = await audio.read()
    try:
        voice = create_voice(
            name=name,
            ref_text=ref_text,
            wav_bytes=audio_bytes,
            language=language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except VoiceValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except VoiceExistsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    from fastapi.responses import JSONResponse

    return JSONResponse(content=voice, status_code=201)


@app.delete("/api/model-lab/voices/{voice_id}")
async def delete_model_lab_voices(voice_id: str) -> dict:
    """Delete a voice from the library.

    Path param: `voice_id` (the voice's ID, may contain unicode).

    Returns `{"ok": true}` on success.

    Raises 404 if voice not found.
    """
    try:
        delete_voice(voice_id)
    except VoiceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {"ok": True}


@app.get("/api/model-providers")
async def get_model_providers() -> dict:
    """Return the current effective Model Provider configuration (which
    provider/model serves each capability: text/speech/transcription, plus
    the reserved `omni` placeholder) and which local engine is active, in
    the exact shape `client/src/hooks/useModelProviders.ts` expects (see
    app/model_providers.py's `effective_providers_payload`).
    """
    settings = load_settings()
    return effective_providers_payload(settings)


@app.put("/api/model-providers")
async def put_model_providers(request: dict) -> dict:
    """Accept a partial Model Provider config, merge it over the persisted
    config (any `cloud.omni` value in the request is ignored -- `omni` is a
    reserved placeholder, never independently settable, see
    app/model_providers.py), persist it, and return the new effective
    config in the same shape as GET.
    """
    settings = load_settings()
    current = load_model_providers()
    updated = apply_providers_partial_update(current, request)
    save_model_providers(updated)
    return effective_providers_payload(settings)


async def run_bot(webrtc_connection: SmallWebRTCConnection) -> None:
    """Build and run the translation pipeline for one WebRTC connection."""
    logger.info("Starting translator pipeline for new connection")

    settings = load_settings()
    worker = build_pipeline_worker(webrtc_connection, settings)

    @webrtc_connection.event_handler("closed")
    async def _on_closed(connection: SmallWebRTCConnection) -> None:
        logger.info("Connection closed, cancelling pipeline worker")
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


@app.post("/api/offer")
async def offer(request: dict, background_tasks: BackgroundTasks):
    """WebRTC signaling endpoint: accepts an SDP offer, returns an SDP answer.

    Mirrors Pipecat's documented SmallWebRTCTransport signaling contract: the
    client POSTs {sdp, type, pc_id?}; we create (or reuse, for renegotiation)
    a SmallWebRTCConnection, hand it an SDP answer, and kick off the pipeline
    as a background task on first connect.
    """
    pc_id = request.get("pc_id")

    if pc_id and pc_id in pcs_map:
        connection = pcs_map[pc_id]
        logger.info(f"Renegotiating existing connection: {pc_id}")
        await connection.renegotiate(
            sdp=request["sdp"],
            type=request["type"],
            restart_pc=request.get("restart_pc", False),
        )
    else:
        connection = SmallWebRTCConnection(ICE_SERVERS)
        await connection.initialize(sdp=request["sdp"], type=request["type"])

        @connection.event_handler("closed")
        async def _on_closed(conn: SmallWebRTCConnection) -> None:
            logger.info(f"Discarding peer connection: {conn.pc_id}")
            pcs_map.pop(conn.pc_id, None)

        background_tasks.add_task(run_bot, connection)

    answer = connection.get_answer()
    pcs_map[answer["pc_id"]] = connection
    return answer


def main() -> None:
    settings = load_settings()
    logger.info(f"Starting Sisyphus translator server on {settings.webrtc_host}:{settings.webrtc_port}")
    logger.info(f"Translation direction: {settings.source_lang} <-> {settings.target_lang}")
    uvicorn.run(app, host=settings.webrtc_host, port=settings.webrtc_port)


if __name__ == "__main__":
    main()
