import asyncio
import unittest

from pipecat.frames.frames import CancelFrame, TranscriptionFrame, UserStoppedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import run_test

from app.pipeline import SemanticBufferProcessor


def transcription(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(text=text, user_id="user", timestamp="now")


def transcription_texts(frames) -> list[str]:
    return [frame.text for frame in frames if isinstance(frame, TranscriptionFrame)]


class CapturingSemanticBuffer(SemanticBufferProcessor):
    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.emitted: list[object] = []

    async def push_frame(
        self,
        frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        self.emitted.append(frame)


class SemanticBufferProcessorTests(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_punctuation_flushes_immediately(self) -> None:
        down, _ = await run_test(
            SemanticBufferProcessor(flush_timeout=10),
            frames_to_send=[transcription("你好。")],
        )

        self.assertEqual(transcription_texts(down), ["你好。"])

    async def test_unpunctuated_text_flushes_after_short_timeout(self) -> None:
        processor = CapturingSemanticBuffer(flush_timeout=0.01)

        await processor.process_frame(transcription("你好"), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.03)

        self.assertEqual(processor.buffered_text, "")
        self.assertEqual(transcription_texts(processor.emitted), ["你好"])

    async def test_user_stop_flushes_before_stop_frame(self) -> None:
        processor = CapturingSemanticBuffer(flush_timeout=10)

        await processor.process_frame(transcription("没有标点"), FrameDirection.DOWNSTREAM)
        await processor.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        relevant = [
            frame
            for frame in processor.emitted
            if isinstance(frame, (TranscriptionFrame, UserStoppedSpeakingFrame))
        ]
        self.assertEqual(
            [type(frame) for frame in relevant],
            [TranscriptionFrame, UserStoppedSpeakingFrame],
        )
        self.assertEqual(relevant[0].text, "没有标点")

    async def test_new_fragment_replaces_timer_without_duplicate_output(self) -> None:
        processor = CapturingSemanticBuffer(flush_timeout=0.02)

        await processor.process_frame(transcription("前半"), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.01)
        await processor.process_frame(transcription("后半"), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.03)

        self.assertEqual(transcription_texts(processor.emitted), ["前半后半"])

    async def test_cancel_discards_buffer_and_pending_timer(self) -> None:
        processor = CapturingSemanticBuffer(flush_timeout=0.01)

        await processor.process_frame(transcription("旧内容"), FrameDirection.DOWNSTREAM)
        await processor.process_frame(CancelFrame(), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.03)

        self.assertEqual(processor.buffered_text, "")
        self.assertEqual(transcription_texts(processor.emitted), [])


if __name__ == "__main__":
    unittest.main()
