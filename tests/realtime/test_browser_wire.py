from app.realtime.browser_wire import (
    BROWSER_ONLY_EVENT_TYPES,
    browser_message_for_media_event,
    browser_message_for_sidecar_event,
)
from app.realtime.events import RealtimeEvent


def _event(event_type: str, payload: dict | None = None, task_id: str | None = None) -> RealtimeEvent:
    return RealtimeEvent(
        event_id="e",
        sequence=1,
        source="pipecat",
        type=event_type,
        timestamp="2026-11-09T00:00:00Z",
        payload=payload or {},
        task_id=task_id,
    )


def test_turn_taking_events_reach_the_browser_flat() -> None:
    for event_type in ("voice.user.started", "voice.user.stopped", "voice.agent.started", "voice.agent.stopped"):
        assert browser_message_for_media_event(_event(event_type)) == {
            "type": event_type,
            "timestamp": "2026-11-09T00:00:00Z",
        }


def test_partial_text_and_barge_in_reason_are_lifted() -> None:
    partial = browser_message_for_media_event(_event("voice.transcript.partial", {"text": "你好"}))
    assert partial is not None and partial["text"] == "你好"

    cancel = browser_message_for_media_event(_event("voice.speech.cancel", {"reason": "barge_in"}))
    assert cancel is not None and cancel["reason"] == "barge_in"


def test_final_transcripts_are_not_duplicated() -> None:
    # server.py already sends finals as `user.transcript` after deduplication.
    assert browser_message_for_media_event(_event("voice.transcript.final", {"text": "x"})) is None


def test_browser_only_events_are_the_agent_speech_boundaries() -> None:
    assert BROWSER_ONLY_EVENT_TYPES == {"voice.agent.started", "voice.agent.stopped"}


def test_task_events_carry_task_id_and_their_detail_field() -> None:
    message = browser_message_for_sidecar_event(_event("task.completed", {"summary": "done"}, task_id="t1"))
    assert message == {
        "type": "task.completed",
        "timestamp": "2026-11-09T00:00:00Z",
        "task_id": "t1",
        "summary": "done",
    }


def test_empty_detail_fields_are_dropped() -> None:
    message = browser_message_for_sidecar_event(_event("task.created", {"goal": ""}, task_id="t1"))
    assert message is not None and "goal" not in message


def test_topics_keep_an_empty_list() -> None:
    message = browser_message_for_sidecar_event(_event("session.topics.updated", {"topics": []}))
    assert message is not None and message["topics"] == []
    assert "task_id" not in message


def test_ecology_events_need_a_band() -> None:
    changed = browser_message_for_sidecar_event(_event("ecology.state.changed", {"state": "reserve"}))
    assert changed is not None and changed["state"] == "reserve"
    assert browser_message_for_sidecar_event(_event("budget.updated", {"used": 3})) is None


def test_unlisted_sidecar_events_stay_server_side() -> None:
    for event_type in ("decision.made", "role.hatched", "voice.speech.enqueue", "diplomacy.elevation.requested"):
        assert browser_message_for_sidecar_event(_event(event_type)) is None
