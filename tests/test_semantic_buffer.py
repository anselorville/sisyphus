import asyncio
import unittest

from pipecat.frames.frames import (
    CancelFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import run_test

from app.realtime.turn_detection import SemanticBufferProcessor


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

    async def test_user_stop_still_flushes_held_text_after_the_segment_wait(self) -> None:
        # The matching transcript of the segment that just ended is still in
        # flight, so the held fragment waits for it -- but is never lost.
        processor = CapturingSemanticBuffer(flush_timeout=0.01, segment_wait=0.03)

        await processor.process_frame(transcription("没有标点"), FrameDirection.DOWNSTREAM)
        await processor.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        self.assertEqual(processor.buffered_text, "没有标点")
        await asyncio.sleep(0.08)

        self.assertEqual(processor.buffered_text, "")
        self.assertEqual(transcription_texts(processor.emitted), ["没有标点"])
        self.assertTrue(any(isinstance(f, UserStoppedSpeakingFrame) for f in processor.emitted))

    async def test_a_pause_inside_a_sentence_does_not_split_the_turn(self) -> None:
        # "你好，" [pause] "请用一句话介绍你自己": the VAD ends the first segment at
        # the pause, and its transcript lands after the user has started again.
        processor = CapturingSemanticBuffer(flush_timeout=0.02, segment_wait=0.2)

        await processor.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await processor.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await processor.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await processor.process_frame(transcription("你好"), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.06)  # longer than flush_timeout: must NOT flush while speaking
        self.assertEqual(transcription_texts(processor.emitted), [])

        await processor.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await processor.process_frame(transcription("请用一句话介绍你自己。"), FrameDirection.DOWNSTREAM)

        self.assertEqual(transcription_texts(processor.emitted), ["你好请用一句话介绍你自己。"])

    async def test_speech_resuming_after_the_flush_timer_started_cancels_it(self) -> None:
        processor = CapturingSemanticBuffer(flush_timeout=0.05, segment_wait=0.2)

        await processor.process_frame(transcription("你好"), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.01)
        await processor.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.1)  # the original 0.05s timer would have fired by now

        self.assertEqual(processor.buffered_text, "你好")
        self.assertEqual(transcription_texts(processor.emitted), [])

    async def test_a_single_segment_turn_pays_no_extra_wait(self) -> None:
        processor = CapturingSemanticBuffer(flush_timeout=0.02, segment_wait=5)

        await processor.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await processor.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await processor.process_frame(transcription("请用一句话介绍你自己"), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.05)

        self.assertEqual(transcription_texts(processor.emitted), ["请用一句话介绍你自己"])

    async def test_a_false_speech_trigger_cannot_hold_text_forever(self) -> None:
        processor = CapturingSemanticBuffer(flush_timeout=0.01, max_hold=0.04)

        await processor.process_frame(transcription("你好"), FrameDirection.DOWNSTREAM)
        await processor.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.1)  # the stop frame never comes

        self.assertEqual(transcription_texts(processor.emitted), ["你好"])

    async def test_ascii_fragments_are_spaced_but_chinese_ones_are_not(self) -> None:
        processor = CapturingSemanticBuffer(flush_timeout=10)

        await processor.process_frame(transcription("Hello"), FrameDirection.DOWNSTREAM)
        await processor.process_frame(transcription("world"), FrameDirection.DOWNSTREAM)
        self.assertEqual(processor.buffered_text, "Hello world")
        await processor.process_frame(transcription("你好"), FrameDirection.DOWNSTREAM)
        self.assertEqual(processor.buffered_text, "Hello world你好")

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
