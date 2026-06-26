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

import httpx
import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from loguru import logger
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.workers.runner import WorkerRunner

from app.config import Settings, load_settings
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
