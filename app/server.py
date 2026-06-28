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
from app.model_lab_preview import PreviewError, preview_speech, preview_text, preview_transcription
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
    "input_text": str}`. Returns `{"output_text": str}`.

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
        output_text = await preview_text(
            adapter_id=adapter_id, values=values, input_text=input_text, settings=settings
        )
    except PreviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        # Missing API key / unconfigured provider, etc. -- same class of
        # error app/pipeline.py's own builders raise at pipeline-build time.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"output_text": output_text}


@app.post("/api/model-lab/preview/speech")
async def post_model_lab_preview_speech(request: dict):
    """Run one real TTS call against the configured service for
    `request["adapter_id"]`, with `request["values"]` applied as draft
    overrides on top of the currently-saved values for that adapter.

    Body: `{"adapter_id": str, "values": {...}, "input_text": str}`.
    Returns a real WAV file (`Content-Type: audio/wav`) -- the concatenated
    `TTSAudioRawFrame.audio` bytes from one real `run_test()` call, wrapped
    in a WAV header built from the frames' own sample_rate/num_channels (see
    `app.model_lab_preview._wav_bytes_from_frames`).
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
        wav_bytes = await preview_speech(
            adapter_id=adapter_id, values=values, input_text=input_text, settings=settings
        )
    except PreviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(content=wav_bytes, media_type="audio/wav")


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

    Returns `{"transcript": str}`.
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
        transcript = await preview_transcription(
            adapter_id=adapter_id, values=parsed_values, audio_wav_bytes=audio_bytes, settings=settings
        )
    except PreviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"transcript": transcript}


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
