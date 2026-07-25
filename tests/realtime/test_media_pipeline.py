import asyncio
from unittest.mock import Mock, patch

from pipecat.frames.frames import TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import LLMService
from pipecat.tests.utils import run_test

from app.config import load_settings
from app.realtime.events import RealtimeEvent
from app.realtime.media_pipeline import build_media_pipeline
from app.realtime.transcription import TranscriptEventProcessor


class PassthroughProcessor(FrameProcessor):
    async def process_frame(self, frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


class FakeTransport:
    def input(self) -> FrameProcessor:
        return PassthroughProcessor()

    def output(self) -> FrameProcessor:
        return PassthroughProcessor()


def test_media_pipeline_contains_no_business_llm() -> None:
    settings = load_settings()
    with (
        patch("app.realtime.media_pipeline.SmallWebRTCTransport", return_value=FakeTransport()),
        patch("app.realtime.media_pipeline.build_stt", return_value=PassthroughProcessor()),
        patch("app.realtime.media_pipeline.build_tts", return_value=PassthroughProcessor()),
    ):
        pipeline, _resources = build_media_pipeline(object(), settings, Mock())

    assert isinstance(pipeline, Pipeline)
    assert not any(isinstance(processor, LLMService) for processor in pipeline.processors)


def test_settings_have_no_translation_language_pair() -> None:
    settings = load_settings()

    assert not hasattr(settings, "source_lang")
    assert not hasattr(settings, "target_lang")


def test_transcript_events_use_the_realtime_event_contract() -> None:
    events: list[RealtimeEvent] = []

    async def sink(event: RealtimeEvent) -> None:
        await asyncio.sleep(0)
        events.append(event)

    processor = TranscriptEventProcessor(sink)
    asyncio.run(
        run_test(
            processor,
            frames_to_send=[
                TranscriptionFrame(text="Call me back.", user_id="speaker", timestamp="now")
            ],
        )
    )

    assert len(events) == 1
    assert events[0].source == "pipecat"
    assert events[0].type == "voice.transcript.final"
    assert events[0].payload == {"text": "Call me back.", "user_id": "speaker"}
