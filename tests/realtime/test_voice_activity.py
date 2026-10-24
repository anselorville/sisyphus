import asyncio

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.tests.utils import SleepFrame, run_test

from app.realtime.events import EventSequence, RealtimeEvent
from app.realtime.queueing import EventPriority, priority_for_event
from app.realtime.transcription import TranscriptEventProcessor
from app.realtime.voice_activity import VoiceActivityEventProcessor


def _run(frames: list, **kwargs) -> list[RealtimeEvent]:
    events: list[RealtimeEvent] = []

    async def sink(event: RealtimeEvent) -> None:
        await asyncio.sleep(0)
        events.append(event)

    processor = VoiceActivityEventProcessor(sink, **kwargs)
    asyncio.run(run_test(processor, frames_to_send=frames))
    return events


def _interim(text: str) -> InterimTranscriptionFrame:
    return InterimTranscriptionFrame(text=text, user_id="u", timestamp="now")


def test_publishes_user_turn_boundaries() -> None:
    events = _run([UserStartedSpeakingFrame(), UserStoppedSpeakingFrame()])

    assert [e.type for e in events] == ["voice.user.started", "voice.user.stopped"]
    assert all(e.source == "pipecat" for e in events)
    assert [e.sequence for e in events] == [1, 2]


def test_barge_in_publishes_cancel_before_user_started_only_while_bot_speaks() -> None:
    quiet = _run([UserStartedSpeakingFrame()])
    assert [e.type for e in quiet] == ["voice.user.started"]

    interrupting = _run([BotStartedSpeakingFrame(), UserStartedSpeakingFrame()])
    assert [e.type for e in interrupting] == ["voice.speech.cancel", "voice.user.started"]
    assert interrupting[0].payload == {"reason": "barge_in"}

    after_bot_done = _run(
        [BotStartedSpeakingFrame(), BotStoppedSpeakingFrame(), UserStartedSpeakingFrame()]
    )
    assert [e.type for e in after_bot_done] == ["voice.user.started"]


def test_partial_transcripts_are_published_once_per_change() -> None:
    events = _run([_interim("你"), _interim("你"), _interim("你好"), _interim("  ")])

    assert [(e.type, e.payload) for e in events] == [
        ("voice.transcript.partial", {"text": "你"}),
        ("voice.transcript.partial", {"text": "你好"}),
    ]


def test_a_new_turn_republishes_the_same_partial_text() -> None:
    # Interim text is a data frame and UserStarted is a system frame (they do
    # not share an ordering guarantee), so let each one drain before the next.
    events = _run(
        [_interim("好"), SleepFrame(0.05), UserStartedSpeakingFrame(), SleepFrame(0.05), _interim("好")]
    )

    assert [e.type for e in events] == [
        "voice.transcript.partial",
        "voice.user.started",
        "voice.transcript.partial",
    ]


def test_a_failing_sink_never_breaks_the_frame_flow() -> None:
    seen: list[str] = []

    async def exploding_sink(event: RealtimeEvent) -> None:
        seen.append(event.type)
        raise RuntimeError("sidecar down")

    processor = VoiceActivityEventProcessor(exploding_sink)
    received, _ = asyncio.run(
        run_test(processor, frames_to_send=[UserStartedSpeakingFrame(), UserStoppedSpeakingFrame()])
    )

    assert seen == ["voice.user.started", "voice.user.stopped"]
    assert any(isinstance(f, UserStoppedSpeakingFrame) for f in received)


def test_shared_sequence_keeps_numbering_gap_free_across_processors() -> None:
    events: list[RealtimeEvent] = []

    async def sink(event: RealtimeEvent) -> None:
        events.append(event)

    sequence = EventSequence()
    # run_test() drives a processor once; use a fresh one per run, sharing the allocator.
    asyncio.run(
        run_test(VoiceActivityEventProcessor(sink, sequence), frames_to_send=[UserStartedSpeakingFrame()])
    )
    asyncio.run(
        run_test(
            TranscriptEventProcessor(sink, sequence),
            frames_to_send=[TranscriptionFrame(text="你好", user_id="u", timestamp="now")],
        )
    )
    asyncio.run(
        run_test(VoiceActivityEventProcessor(sink, sequence), frames_to_send=[UserStoppedSpeakingFrame()])
    )

    assert [e.sequence for e in events] == [1, 2, 3]


def test_bridge_priorities_match_event_urgency() -> None:
    def event(event_type: str) -> RealtimeEvent:
        return RealtimeEvent(
            event_id="e", sequence=1, source="pipecat", type=event_type, timestamp="t", payload={}
        )

    assert priority_for_event(event("voice.speech.cancel")) is EventPriority.CRITICAL
    assert priority_for_event(event("voice.transcript.partial")) is EventPriority.COALESCIBLE
    assert priority_for_event(event("voice.transcript.final")) is EventPriority.DURABLE
    assert priority_for_event(event("voice.user.started")) is EventPriority.DURABLE
