"""Local-processing-budget test for barge-in cancellation.

This measures only the in-process cost of SpeechQueueProcessor reacting to a
UserStartedSpeakingFrame (which drives SpeechQueue.cancel_current() -- see
app/realtime/speech_queue.py). It is NOT an end-to-end latency test: the
larger audio-in-to-audio-stopped budget (150ms, including any sidecar hop)
is validated separately by integration/hardware tests, not here. See
app/realtime/performance.py for the budget constants used below.
"""

import time

import pytest
from pipecat.frames.frames import UserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection

from app.realtime.performance import LOCAL_BARGE_IN_BUDGET_MS, percentile_ms
from app.realtime.speech_queue import SpeechQueue, SpeechQueueProcessor

ITERATIONS = 10_000


class _DiscardingSpeechQueueProcessor(SpeechQueueProcessor):
    """push_frame is a no-op so each iteration measures only this module's
    own local cancel-path cost, not Pipecat's pipeline-linking/StartFrame
    machinery (irrelevant to the local budget under test here)."""

    async def push_frame(
        self, frame, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        return None


@pytest.mark.asyncio
async def test_local_barge_in_cancel_p95_is_under_budget() -> None:
    queue = SpeechQueue(capacity=8)
    processor = _DiscardingSpeechQueueProcessor(queue)

    samples_ns: list[int] = []
    for _ in range(ITERATIONS):
        await queue.mark_speaking("t1")
        start_ns = time.perf_counter_ns()
        await processor.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        samples_ns.append(time.perf_counter_ns() - start_ns)

    p95_ms = percentile_ms(samples_ns, 95)
    assert p95_ms < LOCAL_BARGE_IN_BUDGET_MS
