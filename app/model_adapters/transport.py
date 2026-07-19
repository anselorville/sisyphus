"""Transport adapters: the *how* of model communication.

Each adapter knows one wire protocol (HTTP REST, WebSocket, OpenAI SDK)
and translates between Pipecat frames and that protocol.  Adapters are
stateless with respect to model parameters -- everything model-specific
lives in ``ModelManifest`` (app/model_adapters/manifest.py).

Lifecycle (for every adapter):

    adapter = SomeTransport(manifest)
    await adapter.start()           # open connection / create client
    async for frame in adapter.run(input_data):
        ...                          # Pipecat frames
    await adapter.stop()            # close connection / teardown

``run()`` is the single entry point: it takes input (text, audio bytes,
or a prompt) and yields Pipecat frames (TranscriptionFrame, TTSAudioRawFrame,
LLMTextFrame, or ErrorFrame).  The caller (a Pipecat Service or the Model Lab
preview path) only cares about frames -- the adapter owns all protocol details.
"""

from __future__ import annotations

import base64
import json
import io
from collections.abc import AsyncGenerator
from typing import Any

import av
import httpx
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame, TranscriptionFrame
from pipecat.utils.time import time_now_iso8601

from app.model_adapters.manifest import ModelManifest


class HttpRestTransport:
    """Generic HTTP REST transport for batch-inference endpoints.

    Covers models like OpenRouter ASR (POST /audio/transcriptions with
    base64-encoded audio in a JSON body) and Edge TTS (POST text, stream
    MP3 chunks back).  The manifest's ``request_template`` dictates exactly
    how the input is serialised into the HTTP request; the manifest's
    ``response_text_path`` dictates where to find the transcription text
    in the JSON response (e.g. ``"text"`` or ``"result.transcript"``).
    """

    def __init__(self, manifest: ModelManifest, api_key: str = "", *, timeout: float = 30.0) -> None:
        self._manifest = manifest
        self._api_key = api_key
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        self._client = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            timeout=self._timeout,
        )

    async def stop(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        """POST base64-encoded WAV audio to the manifest's URL, yield a
        ``TranscriptionFrame`` with the response text.

        ``audio`` must already be WAV-encoded (Pipecat's
        ``SegmentedSTTService`` wraps buffered PCM into a WAV container
        before calling ``run_stt`` -- see ``_handle_user_stopped_speaking``).
        """
        if not self._client:
            yield ErrorFrame(error="HttpRestTransport not started")
            return

        template = self._manifest.request_template or {}
        body: dict[str, Any] = _interpolate_template(
            template,
            model=self._manifest.model,
            audio_b64=base64.b64encode(audio).decode("ascii"),
        )

        try:
            response = await self._client.post(
                self._manifest.transport_url,
                content=json.dumps(body),
            )

            if response.status_code != 200:
                logger.error(
                    f"HttpRestTransport STT error "
                    f"(status: {response.status_code}, body: {response.text})"
                )
                yield ErrorFrame(
                    error=f"Transcription error (status: {response.status_code})"
                )
                return

            data = response.json()
            text = _extract_json_path(data, self._manifest.response_text_path)
            if not text:
                logger.warning(
                    f"HttpRestTransport: empty transcription "
                    f"(path={self._manifest.response_text_path})"
                )
                return

            logger.debug(f"HttpRestTransport transcription: [{text}]")
            yield TranscriptionFrame(
                text, "", time_now_iso8601()
            )
        except Exception as exc:
            yield ErrorFrame(error=f"HttpRestTransport STT failed: {exc}")


class EdgeTtsTransport(HttpRestTransport):
    """Edge TTS variant: POST text, receive MP3 stream, decode to PCM frames.

    Replaces the bespoke ``ToneAwareEdgeTTSService``'s inline HTTP+decode
    logic with a transport adapter that yields ``TTSAudioRawFrame`` chunks
    directly.  Voice selection (per-language) is still the caller's
    responsibility -- the manifest defines the endpoint, this adapter only
    handles the MP3→PCM decode.
    """

    async def run_tts(self, text: str, voice: str) -> AsyncGenerator[Frame, None]:
        if not self._client:
            yield ErrorFrame(error="EdgeTtsTransport not started")
            return

        try:
            # Edge TTS communicates via the `edge-tts` Python package, not
            # raw HTTP -- delegate to a lightweight wrapper that yields
            # decoded PCM chunks.
            import edge_tts

            communicate = edge_tts.Communicate(text, voice)
            mp3_chunks: list[bytes] = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    mp3_chunks.append(chunk["data"])

            if not mp3_chunks:
                logger.warning(f"EdgeTtsTransport: no audio for [{text!r}]")
                return

            pcm_bytes = _decode_mp3_to_pcm(b"".join(mp3_chunks))
            chunk_size = 24000 // 10 * 2  # ~100ms at 24kHz mono s16le
            for i in range(0, len(pcm_bytes), chunk_size):
                yield TTSAudioRawFrame(
                    audio=pcm_bytes[i : i + chunk_size],
                    sample_rate=24000,
                    num_channels=1,
                )
        except Exception as exc:
            yield ErrorFrame(error=f"EdgeTtsTransport TTS failed: {exc}")


# ── helpers ──────────────────────────────────────────────────────────

def _interpolate_template(template: dict, **kwargs: Any) -> dict:
    """Recursively interpolate ``{key}`` placeholders in a dict template.

    Only top-level string values are interpolated; nested dicts/lists are
    recursed into.
    """
    result: dict[str, Any] = {}
    for key, value in template.items():
        if isinstance(value, str):
            result[key] = value.format(**kwargs)
        elif isinstance(value, dict):
            result[key] = _interpolate_template(value, **kwargs)
        elif isinstance(value, list):
            result[key] = [
                _interpolate_template(v, **kwargs) if isinstance(v, dict) else v
                for v in value
            ]
        else:
            result[key] = value
    return result


def _extract_json_path(data: dict, path: str) -> str:
    """Extract a dotted-path value from a JSON dict, e.g. ``"text"`` or
    ``"result.transcript"``.  Returns empty string for missing keys."""
    parts = path.split(".")
    current: Any = data
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return ""
    return str(current or "").strip()


def _decode_mp3_to_pcm(mp3_bytes: bytes) -> bytes:
    """Decode MP3 to raw PCM s16le at 24kHz mono."""
    container = av.open(io.BytesIO(mp3_bytes))
    resampler = av.AudioResampler(format="s16", layout="mono", rate=24000)
    pcm_chunks: list[bytes] = []
    for frame in container.decode(audio=0):
        for rf in resampler.resample(frame):
            pcm_chunks.append(bytes(rf.planes[0]))
    for rf in resampler.resample(None):
        pcm_chunks.append(bytes(rf.planes[0]))
    return b"".join(pcm_chunks)
