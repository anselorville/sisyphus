import unittest

from pipecat.frames.frames import InterruptionFrame, TTSAudioRawFrame, TTSStartedFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import SleepFrame, run_test

from app.realtime.audio_gate import MicStateFrame, TTSOutputGateProcessor


class CapturingTTSOutputGate(TTSOutputGateProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.emitted: list[object] = []

    async def push_frame(
        self,
        frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        self.emitted.append(frame)


class TTSOutputGateProcessorTests(unittest.IsolatedAsyncioTestCase):
    async def test_mic_close_releases_buffered_tts_frames_in_arrival_order(self) -> None:
        processor = CapturingTTSOutputGate()
        started = TTSStartedFrame()
        audio = TTSAudioRawFrame(audio=b"speech", sample_rate=16000, num_channels=1)

        await processor.process_frame(MicStateFrame(open=True), FrameDirection.DOWNSTREAM)
        await processor.process_frame(started, FrameDirection.DOWNSTREAM)
        await processor.process_frame(audio, FrameDirection.DOWNSTREAM)
        await processor.process_frame(MicStateFrame(open=False), FrameDirection.DOWNSTREAM)

        self.assertEqual(processor.emitted, [started, audio])

    async def test_interruption_drops_buffered_tts_before_the_next_mic_close(self) -> None:
        buffered_audio = TTSAudioRawFrame(
            audio=b"cancelled", sample_rate=16000, num_channels=1
        )
        interruption = InterruptionFrame()

        down, _ = await run_test(
            TTSOutputGateProcessor(),
            frames_to_send=[
                MicStateFrame(open=True),
                buffered_audio,
                SleepFrame(0.01),
                interruption,
                SleepFrame(0.01),
                MicStateFrame(open=False),
            ],
        )

        self.assertEqual([frame for frame in down if isinstance(frame, InterruptionFrame)], [interruption])
        self.assertNotIn(buffered_audio, down)


if __name__ == "__main__":
    unittest.main()
