from app.realtime.events import RealtimeEvent, decode_event, encode_event


def test_realtime_event_round_trip() -> None:
    event = RealtimeEvent(
        event_id="evt_1",
        sequence=1,
        source="pipecat",
        type="voice.transcript.final",
        timestamp="2026-07-25T12:00:00Z",
        payload={"text": "check test"},
    )

    assert decode_event(encode_event(event)) == event
