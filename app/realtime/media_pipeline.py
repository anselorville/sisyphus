"""Pure speech media plane for one realtime WebRTC connection."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from pipecat.pipeline.pipeline import Pipeline
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from app.config import Settings
from app.providers import build_stt, build_tts

from .audio_gate import MicGateProcessor, TTSOutputGateProcessor
from .events import RealtimeEvent
from .speech_queue import SpeechQueue, SpeechQueueProcessor
from .transcription import EventSink, SpeechInputProcessor, TranscriptEventProcessor
from .turn_detection import SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS, SemanticBufferProcessor


def _ignore_event(_event: RealtimeEvent) -> None:
    return None


def build_media_pipeline(
    connection: SmallWebRTCConnection,
    settings: Settings,
    agent_link: object | None,
    event_sink: EventSink | None = None,
    speech_queue: SpeechQueue | None = None,
) -> tuple[Pipeline, dict[str, object]]:
    """Build the STT -> agent-link -> TTS media plane without an LLM service.

    ``speech_queue`` is the inbound counterpart to ``event_sink``: instead of
    the pipeline publishing events outward, sidecar-originated speech
    (progress narration, elevation prompts, acks, final answers) is pushed
    in from outside via ``SpeechQueue.enqueue()`` and spoken by
    ``SpeechQueueProcessor``. No WebSocket bridge is wired up here -- the
    queue is created (or accepted) and handed back via the returned
    resources dict under ``"speech_queue"`` so that piece can be built and
    plugged in separately.
    """
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    stt = build_stt(settings)
    tts = build_tts(settings)
    transcript_events = TranscriptEventProcessor(event_sink or _ignore_event)
    speech_queue = speech_queue if speech_queue is not None else SpeechQueue()
    processors: list[object] = [
        transport.input(),
        stt,
        SemanticBufferProcessor(flush_timeout=SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS),
        transcript_events,
        SpeechInputProcessor(agent_link),
        SpeechQueueProcessor(speech_queue),
        tts,
        transport.output(),
    ]
    if settings.turn_mode == "manual":
        processors.insert(1, MicGateProcessor())
        processors.insert(-1, TTSOutputGateProcessor())

    return Pipeline(processors), {
        "transport": transport,
        "stt": stt,
        "tts": tts,
        "transcript_events": transcript_events,
        "speech_queue": speech_queue,
    }
