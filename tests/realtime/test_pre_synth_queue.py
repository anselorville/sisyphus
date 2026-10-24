import pytest
from pipecat.frames.frames import EndFrame, InterruptionFrame, TTSAudioRawFrame, UserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import SleepFrame, run_test

from app.realtime.pre_synth_queue import PreSynthQueueProcessor
from app.realtime.speech_queue import SpeechQueue, SpeechRequest


class FakeTTS:
    async def run_tts(self, text: str, context_id: str):
        yield TTSAudioRawFrame(audio=text.encode(), sample_rate=16_000, num_channels=1)

    async def stop(self, frame) -> None:
        return None


class CapturingPreSynthQueueProcessor(PreSynthQueueProcessor):
    def __init__(self, queue: SpeechQueue) -> None:
        super().__init__(queue, tts_factory=FakeTTS, concurrency=1)
        self.emitted: list[object] = []

    async def push_frame(
        self,
        frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        self.emitted.append(frame)
        await super().push_frame(frame, direction)


class EnqueueAfterBargeInProcessor(CapturingPreSynthQueueProcessor):
    async def process_frame(self, frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, UserStartedSpeakingFrame):
            await self._queue.enqueue(SpeechRequest("第二句", "final", "task-1", 100))


@pytest.mark.asyncio
async def test_pre_synth_workers_resume_after_barge_in() -> None:
    queue = SpeechQueue(capacity=8)
    processor = EnqueueAfterBargeInProcessor(queue)
    await queue.enqueue(SpeechRequest("第一句", "ack", "task-1", 20))
    await run_test(
        processor,
        frames_to_send=[
            SleepFrame(0.02),
            UserStartedSpeakingFrame(),
            SleepFrame(0.02),
            EndFrame(),
        ],
    )

    audio = [frame.audio for frame in processor.emitted if isinstance(frame, TTSAudioRawFrame)]
    assert "第二句".encode() in audio


@pytest.mark.asyncio
async def test_barge_in_flushes_audio_already_handed_to_the_transport() -> None:
    processor = CapturingPreSynthQueueProcessor(SpeechQueue(capacity=8))

    await run_test(
        processor,
        frames_to_send=[SleepFrame(0.02), UserStartedSpeakingFrame(), SleepFrame(0.02), EndFrame()],
    )

    # Without an InterruptionFrame the output transport keeps playing its buffer.
    assert any(isinstance(frame, InterruptionFrame) for frame in processor.emitted)
