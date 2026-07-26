import asyncio
import unittest

from pipecat.frames.frames import (
    InputAudioRawFrame,
    InputTransportMessageFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from app.realtime.audio_gate import MicGateProcessor, MicStateFrame


class CapturingMicGate(MicGateProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.emitted: list[object] = []

    async def push_frame(
        self,
        frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        self.emitted.append(frame)


class MicGateProcessorTests(unittest.IsolatedAsyncioTestCase):
    async def test_mic_messages_emit_turn_frames_in_order_and_are_consumed(self) -> None:
        processor = CapturingMicGate()

        await processor.process_frame(
            InputTransportMessageFrame(message={"type": "mic", "open": True}),
            FrameDirection.DOWNSTREAM,
        )
        await processor.process_frame(
            InputTransportMessageFrame(message={"type": "mic", "open": False}),
            FrameDirection.DOWNSTREAM,
        )
        await asyncio.sleep(0.25)

        self.assertEqual(
            [type(frame) for frame in processor.emitted],
            [
                MicStateFrame,
                VADUserStartedSpeakingFrame,
                UserStartedSpeakingFrame,
                MicStateFrame,
                VADUserStoppedSpeakingFrame,
                UserStoppedSpeakingFrame,
            ],
        )
        self.assertEqual(
            [frame.open for frame in processor.emitted if isinstance(frame, MicStateFrame)],
            [True, False],
        )

    async def test_audio_arriving_during_close_grace_is_forwarded_then_closed_audio_is_silent(self) -> None:
        processor = CapturingMicGate()
        await processor.process_frame(
            InputTransportMessageFrame(message={"type": "mic", "open": True}),
            FrameDirection.DOWNSTREAM,
        )
        await processor.process_frame(
            InputTransportMessageFrame(message={"type": "mic", "open": False}),
            FrameDirection.DOWNSTREAM,
        )

        grace_audio = InputAudioRawFrame(audio=b"tail", sample_rate=16000, num_channels=1)
        await processor.process_frame(grace_audio, FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.25)
        closed_audio = InputAudioRawFrame(audio=b"noise", sample_rate=16000, num_channels=1)
        await processor.process_frame(closed_audio, FrameDirection.DOWNSTREAM)

        audio_frames = [
            frame for frame in processor.emitted if isinstance(frame, InputAudioRawFrame)
        ]
        self.assertEqual([frame.audio for frame in audio_frames], [b"tail", b"\x00" * 5])


if __name__ == "__main__":
    unittest.main()
