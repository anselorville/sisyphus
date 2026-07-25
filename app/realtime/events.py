from typing import Literal

import msgspec


EventSource = Literal["pipecat", "swarm", "pi", "tool", "system"]


class RealtimeEvent(msgspec.Struct, frozen=True):
    event_id: str
    sequence: int
    source: EventSource
    type: str
    timestamp: str
    payload: dict
    interaction_id: str | None = None
    task_id: str | None = None


_encoder = msgspec.json.Encoder()
_decoder = msgspec.json.Decoder(RealtimeEvent)


def encode_event(event: RealtimeEvent) -> bytes:
    return _encoder.encode(event)


def decode_event(data: bytes) -> RealtimeEvent:
    return _decoder.decode(data)
