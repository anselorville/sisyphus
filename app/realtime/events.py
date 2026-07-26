from typing import Literal

import msgspec


EventSource = Literal["pipecat", "swarm", "pi", "tool", "system"]


class RealtimeEvent(msgspec.Struct, frozen=True, omit_defaults=True):
    """`omit_defaults=True` is load-bearing for cross-language compatibility,
    not a size optimization: `interaction_id`/`task_id` are the only two
    fields with a default (`None`), and the TypeScript side's wire schema
    (agent-runtime/src/protocol/events.ts's `interaction_id?: string` /
    `task_id?: string`, validated by protocol/schema.ts's TypeBox
    `Type.Optional(Type.String(...))`) means "this key may be *absent*",
    not "this key's value may be `null`" -- those are different things in
    JSON Schema/TypeBox, and the latter fails validation. Without this, any
    event with an unset task_id (e.g. the very first
    `voice.transcript.final` for a brand new interaction, which by
    definition has no task yet) would encode an explicit `"task_id": null`
    and be rejected by the sidecar as an invalid RealtimeEvent. Decoding is
    unaffected either way: an omitted key and an explicit `null` both leave
    a msgspec Struct field at its declared default.
    """

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
