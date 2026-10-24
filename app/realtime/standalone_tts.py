"""Drive a pipecat ``TTSService`` one utterance at a time, outside any pipeline.

``PreSynthQueueProcessor`` wants a plain object with ``run_tts(text, context_id)``
yielding audio frames. A pipecat ``TTSService`` is not that: it is a frame
processor that only works once it has been set up and started inside a
pipeline (that is where it learns its output sample rate, creates its audio
contexts and opens its connection). Calling ``run_tts`` on a service that was
merely constructed fails -- HTTP services such as OpenRouter crash with
``range() arg 3 must not be zero`` -- so before this adapter existed no
spoken reply ever reached the speaker.

``StandaloneTTS`` keeps the simple contract and uses the supported way of
driving a service: each utterance goes through a one-shot mini pipeline
``[tts, collector]`` (the same mechanism ``app.model_lab_preview.preview_speech``
has always used), and the collected audio frames are yielded back. A fresh
service is built per utterance, so no connection or state is shared between
the concurrent synthesis lanes, and a cancelled (barge-in) utterance leaves
nothing behind.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable

from pipecat.frames.frames import EndFrame, Frame, TTSAudioRawFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.tts_service import TTSService
from pipecat.workers.runner import WorkerRunner

# The rate the media plane's output transport runs at (pipecat's default); the
# transport resamples anything else, so this only picks what the service targets.
DEFAULT_OUTPUT_SAMPLE_RATE = PipelineParams().audio_out_sample_rate


def _consume_result(task: asyncio.Task) -> None:
    """Retrieve a detached pipeline's outcome so a late failure is not reported as never-retrieved."""
    if not task.cancelled():
        task.exception()


class _AudioCollector(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.chunks: list[TTSAudioRawFrame] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            self.chunks.append(frame)
        await self.push_frame(frame, direction)


class StandaloneTTS:
    """``run_tts``/``stop`` facade over a ``TTSService`` factory (see module doc)."""

    def __init__(
        self,
        service_factory: Callable[[], TTSService],
        *,
        sample_rate: int = DEFAULT_OUTPUT_SAMPLE_RATE,
    ) -> None:
        self._service_factory = service_factory
        self._sample_rate = sample_rate

    async def run_tts(self, text: str, context_id: str) -> AsyncIterator[TTSAudioRawFrame]:
        for chunk in await self._synthesize(text):
            yield chunk

    async def stop(self, frame: object) -> None:
        # Nothing outlives a single utterance, so there is nothing to release.
        return None

    async def _synthesize(self, text: str) -> list[TTSAudioRawFrame]:
        collector = _AudioCollector()
        worker = PipelineWorker(
            Pipeline([self._service_factory(), collector]),
            cancel_on_idle_timeout=False,
            params=PipelineParams(audio_out_sample_rate=self._sample_rate),
        )
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)

        async def feed() -> None:
            await worker.queue_frame(TTSSpeakFrame(text))
            await worker.queue_frame(EndFrame())

        run_task = asyncio.ensure_future(runner.run())
        try:
            await feed()
            # asyncio.wait, not `await run_task`: the pipecat runner swallows a
            # cancellation delivered to it, which would make our own cancel
            # (barge-in) vanish; wait() leaves the runner alone and raises.
            await asyncio.wait({run_task})
            run_task.result()
        except asyncio.CancelledError:
            # Barge-in: give control back at once and leave the mini pipeline
            # to finish on its own. Its EndFrame is already queued, so it winds
            # down by itself once the in-flight request returns (a few seconds
            # at worst); cancelling or awaiting it instead would stall the user
            # being heard behind that request, and pipecat's runner does not
            # reliably unwind when cancelled mid-request.
            run_task.add_done_callback(_consume_result)
            raise
        return collector.chunks
