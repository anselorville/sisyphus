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

import uvicorn
from fastapi import BackgroundTasks, FastAPI
from fastapi.staticfiles import StaticFiles
from loguru import logger
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.workers.runner import WorkerRunner

from app.config import load_settings
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
