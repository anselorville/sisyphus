"""MiniMax T2A v2 **WebSocket** streaming TTS service.

Why WebSocket and not Pipecat's built-in `MiniMaxTTSService`: the built-in
service speaks MiniMax's HTTP streaming endpoint, paying connection/request
setup per utterance. The WebSocket endpoint keeps ONE connection and ONE
task alive for the whole session, and every subsequent utterance is just a
`task_continue` text message -- verified live from this machine
(docs/minimax/voice-capability-1784391256/manifest.json describes the
protocol; every claim below was re-verified against the real endpoint):

    wss://api.minimaxi.com/ws/v1/t2a_v2   (Authorization: Bearer <key>)

    server: {"event": "connected_success", "session_id": ...}
    client: {"event": "task_start", "model": ..., "voice_setting": {...},
             "audio_setting": {...}, "language_boost": ...}
    server: {"event": "task_started", ...}
    client: {"event": "task_continue", "text": "..."}         (repeatable)
    server: {"event": "task_continued", "data": {"audio": "<hex>"}, ...}
            ... more audio chunks ...
            {..., "is_final": true}                            (utterance done)
    client: {"event": "task_finish"}                           (end session)

Measured live (this session): connect+handshake 0.41s (paid once), then
per-utterance time-to-first-audio-chunk 0.22-0.31s with `format="pcm"`
(raw 16-bit PCM at the requested sample rate, hex-encoded in the JSON --
no MP3 decode step at all). That beats the Cartesia path's measured
0.23-0.55s TTFB and is far more stable, hence this provider.

Interruption handling: if `run_tts` is cancelled mid-stream (barge-in),
the connection is left with unread audio chunks belonging to the cancelled
utterance, so it is closed and dropped; the next utterance lazily
reconnects (~0.4s once, cheaper than desynchronizing the stream).
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import TYPE_CHECKING, Any

import websockets
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.tts_service import TTSService
from pipecat.utils.tracing.service_decorators import traced_tts

from app.config import Settings

if TYPE_CHECKING:
    from app.pipeline import TranslationDirectionStripper

MINIMAX_WS_URL = "wss://api.minimaxi.com/ws/v1/t2a_v2"
MINIMAX_DEFAULT_TTS_MODEL = "speech-2.8-hd"
# The one voice id verified live against this account (carried from the
# capability manifest). Model Lab's cloud:speech `voice` field overrides it.
MINIMAX_DEFAULT_VOICE_ID = "male-qn-badao-jingpin"
MINIMAX_SAMPLE_RATE = 24000

# System-voice catalog (327 ids, sourced from the omlx-voice-lab project's
# adapter config for minimax speech-2.8-* -- both hd and turbo share the
# same list). Kept as a sibling JSON data file rather than a Python literal
# so this module stays readable; app/model_adapters injects these as the
# Model Lab cloud:speech voice options whenever the active cloud speech
# provider is minimax.
_VOICES_PATH = Path(__file__).resolve().parent / "minimax_voices.json"


def minimax_voice_ids() -> list[str]:
    """The selectable MiniMax voice_id catalog ([] if the data file is
    missing/corrupt -- callers fall back to a free-text field)."""
    try:
        data = json.loads(_VOICES_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    ids = data.get("voice_ids")
    return [str(v) for v in ids] if isinstance(ids, list) else []


class MiniMaxWSTTSService(TTSService):
    """Streaming TTS over MiniMax's persistent T2A WebSocket.

    One websocket + one task per pipeline lifetime (lazily [re]established);
    each `run_tts` call is a single `task_continue` exchange. See module
    docstring for the verified wire protocol and latency numbers.
    """

    def __init__(
        self,
        *,
        api_key: str,
        model: str = MINIMAX_DEFAULT_TTS_MODEL,
        voice_id: str = MINIMAX_DEFAULT_VOICE_ID,
        speed: float | None = None,
        pitch: int | None = None,
        volume: float | None = None,
        tone_source: "TranslationDirectionStripper | None" = None,
        **kwargs: Any,
    ) -> None:
        # push_start_frame/push_stop_frames: the base class brackets the
        # yielded audio in TTSStarted/StoppedFrames itself (same flags the
        # built-in HTTP MiniMax service uses), so run_tts only yields audio.
        super().__init__(
            sample_rate=MINIMAX_SAMPLE_RATE,
            push_start_frame=True,
            push_stop_frames=True,
            **kwargs,
        )
        self._api_key = api_key
        self._model = model
        self._voice_id = voice_id
        self._speed = speed
        self._pitch = pitch
        self._volume = volume
        # Reserved for tone->emotion mapping later; MiniMax's voice_setting
        # emotion enum is model-dependent and unverified, so unused today.
        self._tone_source = tone_source
        self._ws: Any = None
        # run_tts is invoked per sentence and could in principle overlap
        # (speculative pipelining upstream); a single connection cannot
        # interleave two utterances, so serialize.
        self._lock = asyncio.Lock()

    def can_generate_metrics(self) -> bool:
        return True

    async def _connect(self) -> None:
        """Open the websocket and start the synthesis task (idempotent)."""
        if self._ws is not None:
            return
        ws = await websockets.connect(
            MINIMAX_WS_URL,
            additional_headers={"Authorization": f"Bearer {self._api_key}"},
        )
        try:
            greeting = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if greeting.get("event") != "connected_success":
                raise RuntimeError(f"unexpected greeting: {greeting}")

            voice_setting: dict[str, Any] = {"voice_id": self._voice_id}
            if self._speed is not None:
                voice_setting["speed"] = self._speed
            if self._pitch is not None:
                voice_setting["pitch"] = self._pitch
            if self._volume is not None:
                voice_setting["vol"] = self._volume

            await ws.send(
                json.dumps(
                    {
                        "event": "task_start",
                        "model": self._model,
                        "voice_setting": voice_setting,
                        "audio_setting": {
                            "sample_rate": MINIMAX_SAMPLE_RATE,
                            "format": "pcm",
                            "channel": 1,
                        },
                        # "auto": the model infers pronunciation language per
                        # text -- the right default for a bidirectional
                        # translator whose output language changes utterance
                        # to utterance.
                        "language_boost": "auto",
                    }
                )
            )
            started = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if started.get("event") != "task_started":
                raise RuntimeError(f"task_start rejected: {started}")
        except Exception:
            await ws.close()
            raise
        self._ws = ws

    async def _drop_connection(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass

    async def stop(self, frame) -> None:  # type: ignore[override]
        await self._drop_connection()
        await super().stop(frame)

    async def cancel(self, frame) -> None:  # type: ignore[override]
        await self._drop_connection()
        await super().cancel(frame)

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        logger.debug(f"{self}: Generating TTS [{text}]")
        async with self._lock:
            clean = False
            try:
                await self._connect()
                await self.start_ttfb_metrics()
                await self.start_tts_usage_metrics(text)
                await self._ws.send(json.dumps({"event": "task_continue", "text": text}))

                first_chunk = True
                while True:
                    message = json.loads(await asyncio.wait_for(self._ws.recv(), 30))
                    base = message.get("base_resp") or {}
                    if base.get("status_code") not in (None, 0):
                        raise RuntimeError(f"MiniMax error: {base}")
                    audio_hex = (message.get("data") or {}).get("audio")
                    if audio_hex:
                        if first_chunk:
                            await self.stop_ttfb_metrics()
                            first_chunk = False
                        yield TTSAudioRawFrame(
                            audio=bytes.fromhex(audio_hex),
                            sample_rate=MINIMAX_SAMPLE_RATE,
                            num_channels=1,
                            context_id=context_id,
                        )
                    if message.get("is_final"):
                        clean = True
                        break
            except asyncio.CancelledError:
                # Barge-in: unread chunks of this utterance are still on the
                # wire -- drop the connection rather than desync the stream.
                await self._drop_connection()
                raise
            except Exception as exc:
                logger.error(f"{self}: TTS failed: {exc}")
                await self._drop_connection()
                yield ErrorFrame(error=f"MiniMax TTS failed: {exc}")
            finally:
                if not clean and self._ws is not None:
                    # Ended without is_final (unexpected shape) -- resync.
                    await self._drop_connection()


def build_minimax_tts(
    settings: Settings,
    direction_stripper: "TranslationDirectionStripper | None",
    *,
    model: str | None = None,
    voice: str | None = None,
    speed: float | None = None,
) -> MiniMaxWSTTSService:
    """Construct the MiniMax WebSocket TTS service.

    `voice`/`speed` come from Model Lab's `cloud:speech` adapter values
    (`voice` is the MiniMax voice_id); `model` from the Model Provider
    selection. Requires `settings.minimax_api_key`.
    """
    return MiniMaxWSTTSService(
        api_key=settings.minimax_api_key,
        model=model or MINIMAX_DEFAULT_TTS_MODEL,
        voice_id=voice or MINIMAX_DEFAULT_VOICE_ID,
        speed=speed,
        tone_source=direction_stripper,
    )
