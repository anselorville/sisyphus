import asyncio

import pytest
from pipecat.frames.frames import TTSSpeakFrame, UserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import SleepFrame, run_test

from app.realtime.queueing import QueueClosed
from app.realtime.speech_queue import SpeechQueue, SpeechQueueProcessor, SpeechRequest


@pytest.mark.asyncio
async def test_elevation_speech_preempts_progress() -> None:
    queue = SpeechQueue(capacity=8)
    await queue.enqueue(SpeechRequest("还在处理", "progress", "t1", 20))
    await queue.enqueue(SpeechRequest("需要你的授权", "elevation", "t1", 100))
    assert (await queue.next()).kind == "elevation"


@pytest.mark.asyncio
async def test_user_started_speaking_cancels_current_audio_locally() -> None:
    queue = SpeechQueue(capacity=8)
    await queue.mark_speaking("t1")
    await queue.cancel_current("barge_in")
    assert queue.current is None


@pytest.mark.asyncio
async def test_default_capacity_is_32() -> None:
    assert SpeechQueue().capacity == 32


@pytest.mark.asyncio
async def test_progress_is_replaced_by_newer_progress_for_same_task() -> None:
    queue = SpeechQueue(capacity=8)
    await queue.enqueue(SpeechRequest("20%", "progress", "t1", 20))
    await queue.enqueue(SpeechRequest("80%", "progress", "t1", 20))

    request = await queue.next()
    assert request.text == "80%"
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(queue.next(), timeout=0.01)


@pytest.mark.asyncio
async def test_progress_for_different_task_is_not_replaced() -> None:
    queue = SpeechQueue(capacity=8)
    await queue.enqueue(SpeechRequest("20%", "progress", "t1", 20))
    await queue.enqueue(SpeechRequest("50%", "progress", "t2", 20))

    first = await queue.next()
    second = await queue.next()
    assert (first.task_id, first.text) == ("t1", "20%")
    assert (second.task_id, second.text) == ("t2", "50%")


@pytest.mark.asyncio
async def test_ack_is_replaced_by_final_for_same_task() -> None:
    queue = SpeechQueue(capacity=8)
    await queue.enqueue(SpeechRequest("好的", "ack", "t1", 10))
    await queue.enqueue(SpeechRequest("完成了", "final", "t1", 50))

    request = await queue.next()
    assert request.kind == "final"
    assert request.text == "完成了"
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(queue.next(), timeout=0.01)


@pytest.mark.asyncio
async def test_final_elevation_and_budget_apply_backpressure_instead_of_dropping() -> None:
    queue = SpeechQueue(capacity=1)
    await queue.enqueue(SpeechRequest("忙", "progress", "t1", 20))

    blocked_enqueue = asyncio.create_task(
        queue.enqueue(SpeechRequest("需要授权", "elevation", "t2", 100))
    )
    await asyncio.sleep(0)
    assert not blocked_enqueue.done()

    drained = await queue.next()
    assert drained.kind == "progress"
    await blocked_enqueue

    assert (await queue.next()).kind == "elevation"


@pytest.mark.asyncio
async def test_progress_is_dropped_when_full_and_not_replaceable() -> None:
    queue = SpeechQueue(capacity=1)
    await queue.enqueue(SpeechRequest("t1 忙", "progress", "t1", 20))

    # A progress update for a *different* task can't replace t1's slot, and
    # the queue is full -- it must be dropped rather than block the producer.
    await asyncio.wait_for(
        queue.enqueue(SpeechRequest("t2 忙", "progress", "t2", 20)), timeout=0.1
    )

    request = await queue.next()
    assert request.task_id == "t1"


@pytest.mark.asyncio
async def test_barge_in_clears_pending_progress_but_preserves_final() -> None:
    queue = SpeechQueue(capacity=8)
    await queue.enqueue(SpeechRequest("忙", "progress", "t1", 20))
    await queue.enqueue(SpeechRequest("完成了", "final", "t2", 50))
    await queue.mark_speaking("t0")

    await queue.cancel_current("barge_in")

    assert queue.current is None
    remaining = await queue.next()
    assert remaining.kind == "final"
    assert remaining.task_id == "t2"
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(queue.next(), timeout=0.01)


@pytest.mark.asyncio
async def test_close_drains_then_rejects_producers_and_consumers() -> None:
    queue = SpeechQueue(capacity=2)
    await queue.enqueue(SpeechRequest("完成了", "final", "t1", 50))
    await queue.close()

    assert (await queue.next()).task_id == "t1"
    with pytest.raises(QueueClosed):
        await queue.next()
    with pytest.raises(QueueClosed):
        await queue.enqueue(SpeechRequest("too late", "progress", "t2", 1))


@pytest.mark.asyncio
async def test_speech_queue_processor_speaks_dequeued_requests_as_tts_frames() -> None:
    queue = SpeechQueue(capacity=4)
    await queue.enqueue(SpeechRequest("完成了", "final", "t1", 50))
    await queue.close()

    processor = SpeechQueueProcessor(queue)
    down, _ = await run_test(processor, frames_to_send=[SleepFrame(0.05)])

    tts_frames = [frame for frame in down if isinstance(frame, TTSSpeakFrame)]
    assert [frame.text for frame in tts_frames] == ["完成了"]


@pytest.mark.asyncio
async def test_user_started_speaking_frame_cancels_locally_without_pipeline_startup() -> None:
    class NoOpPushProcessor(SpeechQueueProcessor):
        async def push_frame(
            self, frame, direction: FrameDirection = FrameDirection.DOWNSTREAM
        ) -> None:
            return None

    queue = SpeechQueue(capacity=4)
    await queue.mark_speaking("t1")
    processor = NoOpPushProcessor(queue)

    # No StartFrame was ever sent, so nothing here can rely on Pipecat's
    # task manager or any pipeline machinery -- if cancellation required
    # anything beyond local queue state, this call would raise.
    await processor.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)

    assert queue.current is None
