import asyncio
from unittest.mock import Mock, patch

from pipecat.frames.frames import Frame, TTSAudioRawFrame, TTSSpeakFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from app.config import load_settings
from app.realtime.media_pipeline import build_media_pipeline
from app.realtime.pre_synth_queue import PreSynthQueueProcessor
from app.realtime.standalone_tts import StandaloneTTS


class FakeTTSService(FrameProcessor):
    """Behaves like a pipeline-driven TTS service: audio only via TTSSpeakFrame."""

    def __init__(self, delay: float = 0.0) -> None:
        super().__init__()
        self._delay = delay

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSSpeakFrame):
            await asyncio.sleep(self._delay)
            for part in (frame.text[:2], frame.text[2:]):
                await self.push_frame(
                    TTSAudioRawFrame(audio=part.encode(), sample_rate=24_000, num_channels=1)
                )
            return
        await self.push_frame(frame, direction)


class PassthroughProcessor(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


def test_yields_the_audio_a_pipeline_driven_service_produces() -> None:
    async def run() -> list[bytes]:
        tts = StandaloneTTS(FakeTTSService)
        return [chunk.audio async for chunk in tts.run_tts("你好吗", "0")]

    assert asyncio.run(run()) == ["你好".encode(), "吗".encode()]


def test_each_utterance_gets_a_fresh_service() -> None:
    built: list[FakeTTSService] = []

    def factory() -> FakeTTSService:
        built.append(FakeTTSService())
        return built[-1]

    async def run() -> None:
        tts = StandaloneTTS(factory)
        async for _ in tts.run_tts("第一句话", "0"):
            pass
        async for _ in tts.run_tts("第二句话", "1"):
            pass

    asyncio.run(run())

    assert len(built) == 2 and built[0] is not built[1]


def test_cancelling_a_barge_in_stops_the_utterance_promptly() -> None:
    async def run() -> float:
        tts = StandaloneTTS(lambda: FakeTTSService(delay=3))

        async def consume() -> None:
            async for _ in tts.run_tts("很长很长的一句话", "0"):
                pass

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.2)
        started = asyncio.get_running_loop().time()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        elapsed = asyncio.get_running_loop().time() - started
        # The detached synthesis finishes by itself; let it, so the loop closes cleanly.
        await asyncio.sleep(3.5)
        return elapsed

    # The cancelled call must come back at once, not after the 3s in-flight synthesis.
    assert asyncio.run(asyncio.wait_for(run(), timeout=15)) < 1


def test_the_media_pipeline_synthesises_through_the_standalone_adapter() -> None:
    # Regression: a bare, never-started TTSService fails ("range() arg 3 must
    # not be zero") so no reply was ever spoken. The speech stage must hand
    # PreSynthQueueProcessor an adapter that drives the service in a pipeline.
    settings = load_settings()
    with (
        patch("app.realtime.media_pipeline.SmallWebRTCTransport", return_value=Mock()),
        patch("app.realtime.media_pipeline.build_stt", return_value=PassthroughProcessor()),
        patch("app.realtime.media_pipeline.build_tts", return_value=FakeTTSService()),
    ):
        pipeline, _resources = build_media_pipeline(object(), settings, Mock())

    pre_synth = next(p for p in pipeline.processors if isinstance(p, PreSynthQueueProcessor))
    assert isinstance(pre_synth._tts_factory(), StandaloneTTS)
