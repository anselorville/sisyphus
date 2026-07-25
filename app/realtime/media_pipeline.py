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
from .transcription import EventSink, SpeechInputProcessor, TranscriptEventProcessor
from .turn_detection import SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS, SemanticBufferProcessor


def _ignore_event(_event: RealtimeEvent) -> None:
    return None


def build_media_pipeline(
    connection: SmallWebRTCConnection,
    settings: Settings,
    agent_link: object | None,
    event_sink: EventSink | None = None,
) -> tuple[Pipeline, dict[str, object]]:
    """Build the STT -> agent-link -> TTS media plane without an LLM service."""
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    stt = build_stt(settings)
    tts = build_tts(settings)
    transcript_events = TranscriptEventProcessor(event_sink or _ignore_event)
    processors: list[object] = [
        transport.input(),
        stt,
        SemanticBufferProcessor(flush_timeout=SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS),
        transcript_events,
        SpeechInputProcessor(agent_link),
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
    }
