# Pipeline Latency Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the semantic fallback wait from three seconds to 500ms, flush buffered transcription at explicit user-turn end, and log Pipecat user-to-bot latency measurements.

**Architecture:** Keep the existing Pipecat pipeline and provider graph. Extend the existing `SemanticBufferProcessor` with explicit turn/lifecycle handling, and isolate latency-observer construction in a new `app/latency.py` module so it can be tested without WebRTC or provider credentials.

**Tech Stack:** Python 3.12, Pipecat 1.4.0, asyncio, Loguru, unittest, Pipecat test utilities

## Global Constraints

- Keep Pipecat, WebRTC, provider selection, translation direction, and existing interruption strategies unchanged.
- Use a named 500ms semantic fallback timeout at pipeline construction.
- Do not add models, providers, persistent metrics storage, API endpoints, or frontend UI.
- Treat live audible barge-in as a manual acceptance gate; automated tests only prove semantic-buffer lifecycle behavior.

---

## File Structure

- Modify `app/pipeline.py`: add turn-aware semantic buffering, the named timeout constant, and worker observer wiring.
- Create `app/latency.py`: construct and configure the Pipecat latency observer and its logging callbacks.
- Create `tests/test_semantic_buffer.py`: async behavior tests for punctuation, timeout, turn-stop, replacement, and cancellation.
- Create `tests/test_latency_observer.py`: observer type, handler registration, callback, and worker wiring tests.
- Modify `README.md`: document latency logging and the live barge-in acceptance procedure.

### Task 1: Turn-Aware Semantic Buffer

**Files:**
- Modify: `app/pipeline.py:620-729`
- Create: `tests/test_semantic_buffer.py`

**Interfaces:**
- Consumes: Pipecat `TranscriptionFrame`, `UserStoppedSpeakingFrame`, `EndFrame`, `CancelFrame`, and `FrameDirection`.
- Produces: `SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS: float = 0.5` and updated `SemanticBufferProcessor.process_frame()` behavior.

- [ ] **Step 1: Write failing punctuation and timeout tests**

Create `tests/test_semantic_buffer.py` with async tests that instantiate `SemanticBufferProcessor(flush_timeout=0.01)`, use `pipecat.tests.utils.run_test`, and assert:

```python
import asyncio
import unittest

from pipecat.frames.frames import (
    CancelFrame,
    TranscriptionFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import run_test

from app.pipeline import SemanticBufferProcessor


def transcription(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(text=text, user_id="user", timestamp="now")


def transcription_texts(frames) -> list[str]:
    return [frame.text for frame in frames if isinstance(frame, TranscriptionFrame)]


class SemanticBufferProcessorTests(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_punctuation_flushes_immediately(self) -> None:
        down, _ = await run_test(
            SemanticBufferProcessor(flush_timeout=10),
            frames_to_send=[transcription("你好。")],
        )
        self.assertEqual(transcription_texts(down), ["你好。"])

    async def test_unpunctuated_text_flushes_after_short_timeout(self) -> None:
        processor = SemanticBufferProcessor(flush_timeout=0.01)
        await processor.process_frame(transcription("你好"), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(0.03)
        self.assertEqual(processor.buffered_text, "")
```

The timeout test initially depends on a missing read-only `buffered_text` property so it fails for the intended missing behavior/API rather than inspecting private state.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
rtk uv run python -m unittest tests.test_semantic_buffer -v
```

Expected: the timeout test fails because `SemanticBufferProcessor` has no `buffered_text` property.

- [ ] **Step 3: Add the named timeout and minimal observable buffer API**

In `app/pipeline.py`, add:

```python
SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS = 0.5
```

Change the constructor default to that constant and add:

```python
@property
def buffered_text(self) -> str:
    return self._buffer
```

Use the constant explicitly in `build_pipeline()`:

```python
semantic_buffer = SemanticBufferProcessor(
    flush_timeout=SEMANTIC_BUFFER_FLUSH_TIMEOUT_SECONDS
)
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Task 1 command and expect both tests to pass.

- [ ] **Step 5: Write failing turn-stop and lifecycle tests**

Extend the same test class with:

```python
class CapturingSemanticBuffer(SemanticBufferProcessor):
    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.emitted: list[object] = []

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM) -> None:
        self.emitted.append(frame)


async def test_user_stop_flushes_before_stop_frame(self) -> None:
    down, _ = await run_test(
        SemanticBufferProcessor(flush_timeout=10),
        frames_to_send=[transcription("没有标点"), UserStoppedSpeakingFrame()],
    )
    relevant = [
        frame for frame in down
        if isinstance(frame, (TranscriptionFrame, UserStoppedSpeakingFrame))
    ]
    self.assertEqual([type(frame) for frame in relevant], [TranscriptionFrame, UserStoppedSpeakingFrame])
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
    self.assertEqual(transcription_texts(processor.emitted), [])
```

- [ ] **Step 6: Run the focused tests and verify RED**

Run the Task 1 command. Expected failures: user stop does not flush and cancel leaves the buffer populated.

- [ ] **Step 7: Implement a single flush primitive and lifecycle handling**

Refactor `SemanticBufferProcessor` around:

```python
async def _flush_buffer(self, direction: FrameDirection) -> None:
    text = self._buffer.strip()
    self._buffer = ""
    if text:
        await self.push_frame(
            TranscriptionFrame(
                text=text,
                user_id=self._last_user_id,
                timestamp=self._last_timestamp,
            ),
            direction,
        )
```

Then make `_schedule_flush()` call `_flush_buffer()`. In `process_frame()`:

- cancel the active timer and flush before forwarding `UserStoppedSpeakingFrame`;
- cancel the timer and clear `_buffer` on `CancelFrame`;
- cancel the timer, flush, then forward `EndFrame` so normal shutdown does not lose accepted text;
- forward all lifecycle frames exactly once;
- retain the existing punctuation splitting behavior.

- [ ] **Step 8: Run Task 1 tests and the existing transcript tests**

Run:

```bash
rtk uv run python -m unittest tests.test_semantic_buffer tests.test_translation_transcript_tap -v
```

Expected: all tests pass with no asyncio pending-task warnings.

- [ ] **Step 9: Commit Task 1**

```bash
rtk git add app/pipeline.py tests/test_semantic_buffer.py
rtk git commit -m "perf: reduce semantic turn buffering latency"
```

### Task 2: User-to-Bot Latency Observer

**Files:**
- Create: `app/latency.py`
- Modify: `app/pipeline.py:1489-1514`
- Create: `tests/test_latency_observer.py`

**Interfaces:**
- Produces: `build_latency_observer() -> UserBotLatencyObserver`.
- Consumes: `build_pipeline_worker()` passes `[build_latency_observer()]` to `PipelineWorker(observers=...)` while preserving existing `PipelineParams`.

- [ ] **Step 1: Write the failing observer builder tests**

Create `tests/test_latency_observer.py`:

```python
import unittest

from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver

from app.latency import build_latency_observer


class LatencyObserverTests(unittest.IsolatedAsyncioTestCase):
    async def test_builder_registers_all_latency_handlers(self) -> None:
        observer = build_latency_observer()
        self.assertIsInstance(observer, UserBotLatencyObserver)
        for event_name in (
            "on_latency_measured",
            "on_latency_breakdown",
            "on_first_bot_speech_latency",
        ):
            self.assertTrue(observer._event_handlers[event_name].handlers)

    async def test_registered_callbacks_accept_representative_events(self) -> None:
        observer = build_latency_observer()
        await observer._call_event_handler("on_latency_measured", 0.42)
        await observer._call_event_handler("on_first_bot_speech_latency", 0.21)
        await observer._call_event_handler("on_latency_breakdown", {"ttfb": []})
```

- [ ] **Step 2: Run the observer tests and verify RED**

Run:

```bash
rtk uv run python -m unittest tests.test_latency_observer -v
```

Expected: import failure because `app.latency` does not exist.

- [ ] **Step 3: Implement the observer builder**

Create `app/latency.py` with a builder that constructs `UserBotLatencyObserver`, registers three async callbacks through `@observer.event_handler(...)`, and logs machine-searchable messages using these stable prefixes:

```python
logger.info("voice_latency user_to_bot_seconds={:.3f}", latency_seconds)
logger.info("voice_latency first_bot_speech_seconds={:.3f}", latency_seconds)
logger.info("voice_latency breakdown={}", breakdown)
```

Return the configured observer.

- [ ] **Step 4: Run the observer tests and verify GREEN**

Run the Task 2 observer command and expect both tests to pass.

- [ ] **Step 5: Write a failing worker-wiring test**

Add a synchronous test that patches `app.pipeline.build_pipeline`, patches
`app.pipeline.build_latency_observer`, constructs `build_pipeline_worker()`, and
asserts the sentinel observer appears in `worker._observers`. Use a minimal
`Pipeline([])` returned by the patched builder; do not construct providers or a
WebRTC connection.

- [ ] **Step 6: Run the worker-wiring test and verify RED**

Run the Task 2 command. Expected: `build_latency_observer` is not imported or the sentinel is absent from the worker.

- [ ] **Step 7: Wire the observer into the worker**

Import `build_latency_observer` in `app/pipeline.py` and change construction to:

```python
return PipelineWorker(
    pipeline,
    observers=[build_latency_observer()],
    params=PipelineParams(
        enable_metrics=True,
        enable_usage_metrics=True,
    ),
)
```

- [ ] **Step 8: Run Task 2 tests and the pipeline construction tests**

Run:

```bash
rtk uv run python -m unittest tests.test_latency_observer -v
rtk uv run pytest -q
```

Expected: all tests pass.

- [ ] **Step 9: Commit Task 2**

```bash
rtk git add app/latency.py app/pipeline.py tests/test_latency_observer.py
rtk git commit -m "feat: log voice pipeline latency"
```

### Task 3: Operational Documentation and Final Verification

**Files:**
- Modify: `README.md:80-100`

**Interfaces:**
- Consumes: stable `voice_latency` log prefixes from Task 2.
- Produces: operator instructions for reading latency logs and manually validating audible barge-in.

- [ ] **Step 1: Update latency and barge-in documentation**

Document:

- the 500ms unpunctuated fallback budget;
- immediate flush at user-turn stop;
- the three `voice_latency` log forms;
- the five-step live barge-in procedure from the design;
- the limitation that passing unit tests does not prove browser playout cancellation.

- [ ] **Step 2: Check documentation and source formatting**

Run:

```bash
rtk git diff --check
```

Expected: exit code 0 and no output.

- [ ] **Step 3: Run the complete backend verification suite**

Run:

```bash
rtk uv run pytest -q
```

Expected: exit code 0 and zero failures.

- [ ] **Step 4: Run frontend build regression check**

Run:

```bash
rtk npm --prefix client run build
```

Expected: TypeScript and Vite build exit code 0.

- [ ] **Step 5: Review exact scope**

Run:

```bash
rtk git status --short
rtk git diff --stat HEAD~2
rtk git diff --check HEAD~2
```

Confirm only the latency design/plan, semantic buffer, latency observer, tests,
and README are part of this work; leave pre-existing `.agents/` or other user
files untouched.

- [ ] **Step 6: Commit documentation**

```bash
rtk git add README.md
rtk git commit -m "docs: add voice latency acceptance guide"
```
