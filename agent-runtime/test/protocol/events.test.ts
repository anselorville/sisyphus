import { describe, expect, it } from "vitest";

import { EVENT_SOURCES, REALTIME_EVENT_TYPES, type RealtimeEvent } from "../../src/protocol/events.js";
import { decodeEvent, encodeEvent, ProtocolValidationError } from "../../src/protocol/schema.js";
import { config } from "../../src/config.js";

const baseEvent: RealtimeEvent = {
  event_id: "11111111-1111-4111-8111-111111111111",
  sequence: 1,
  source: "pipecat",
  type: "voice.transcript.final",
  timestamp: "2026-07-25T00:00:00.000Z",
  payload: { text: "hello there" },
};

/** Builds a payload whose deepest nested object sits exactly `levels` steps below the payload root (root itself is level 0). */
function nestedPayload(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < levels; i += 1) {
    node = { nested: node };
  }
  return node;
}

describe("RealtimeEvent field-for-field contract", () => {
  it("round-trips a full event, including optional fields, through encode/decode", () => {
    const event: RealtimeEvent = {
      ...baseEvent,
      interaction_id: "interaction-1",
      task_id: "task-1",
    };

    const decoded = decodeEvent(encodeEvent(event));

    expect(decoded).toEqual(event);
  });

  it("round-trips an event that omits the optional interaction_id/task_id fields", () => {
    const decoded = decodeEvent(encodeEvent(baseEvent));

    expect(decoded).toEqual(baseEvent);
    expect(decoded).not.toHaveProperty("interaction_id");
    expect(decoded).not.toHaveProperty("task_id");
  });

  it("encodes using Python's exact snake_case field names", () => {
    const json = encodeEvent({ ...baseEvent, interaction_id: "i-1", task_id: "t-1" });
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(
      ["event_id", "interaction_id", "payload", "sequence", "source", "task_id", "timestamp", "type"].sort(),
    );
  });

  it.each(REALTIME_EVENT_TYPES)("accepts the well-known event type %s", (type) => {
    const event: RealtimeEvent = { ...baseEvent, type, payload: {} };

    expect(() => decodeEvent(encodeEvent(event))).not.toThrow();
  });

  it.each(EVENT_SOURCES)("accepts the well-known event source %s", (source) => {
    expect(() => decodeEvent({ ...baseEvent, source })).not.toThrow();
  });

  it("decodeEvent also accepts an already-parsed object, not just a JSON string", () => {
    const decoded = decodeEvent({ ...baseEvent });

    expect(decoded).toEqual(baseEvent);
  });
});

describe("malformed event rejection", () => {
  it("rejects an unknown event type", () => {
    expect(() => decodeEvent({ ...baseEvent, type: "bogus.event" })).toThrow(ProtocolValidationError);
  });

  it("rejects an unknown event source", () => {
    expect(() => decodeEvent({ ...baseEvent, source: "human" })).toThrow(ProtocolValidationError);
  });

  it("rejects a missing required field", () => {
    const { event_id: _event_id, ...withoutEventId } = baseEvent;

    expect(() => decodeEvent(withoutEventId)).toThrow(ProtocolValidationError);
  });

  it("rejects a non-integer sequence", () => {
    expect(() => decodeEvent({ ...baseEvent, sequence: "1" })).toThrow(ProtocolValidationError);
  });

  it("rejects a non-string timestamp", () => {
    expect(() => decodeEvent({ ...baseEvent, timestamp: 12345 })).toThrow(ProtocolValidationError);
  });

  it("ignores an unrecognized top-level field, matching msgspec's default decode behavior", () => {
    expect(() => decodeEvent({ ...baseEvent, unexpected_field: "nope" })).not.toThrow();
  });

  it("rejects malformed JSON text", () => {
    expect(() => decodeEvent("{not valid json")).toThrow(ProtocolValidationError);
  });
});

describe("oversized event rejection", () => {
  it("encodeEvent rejects a payload that would exceed the 64KiB wire limit", () => {
    const event: RealtimeEvent = {
      ...baseEvent,
      payload: { blob: "x".repeat(config.maxEventBytes) },
    };

    expect(() => encodeEvent(event)).toThrow(/size|bytes/i);
  });

  it("decodeEvent rejects an oversized JSON string before attempting to parse it", () => {
    const oversized = `{"padding":"${"x".repeat(config.maxEventBytes)}"}`;

    expect(() => decodeEvent(oversized)).toThrow(/size|bytes/i);
  });
});

describe("payload safety guards", () => {
  it("rejects PCM payloads", () => {
    expect(() =>
      decodeEvent({
        ...baseEvent,
        payload: { pcm: "AAAA" },
      }),
    ).toThrow(/PCM/);
  });

  it("rejects PCM payloads nested arbitrarily deep", () => {
    expect(() =>
      decodeEvent({
        ...baseEvent,
        payload: { audio: { chunk: { raw_pcm_data: "AAAA" } } },
      }),
    ).toThrow(/PCM/);
  });

  it("rejects raw-audio-shaped payload fields", () => {
    expect(() =>
      decodeEvent({
        ...baseEvent,
        payload: { raw_audio: "AAAA" },
      }),
    ).toThrow(/PCM|audio/i);
  });

  it("rejects payloads nested past the configured depth limit", () => {
    expect(() =>
      decodeEvent({
        ...baseEvent,
        payload: nestedPayload(config.maxPayloadDepth + 1),
      }),
    ).toThrow(/depth/i);
  });

  it("accepts a payload nested exactly at the configured depth limit", () => {
    expect(() =>
      decodeEvent({
        ...baseEvent,
        payload: nestedPayload(config.maxPayloadDepth),
      }),
    ).not.toThrow();
  });

  it("rejects PCM fields hidden inside an array payload", () => {
    expect(() =>
      decodeEvent({
        ...baseEvent,
        payload: { frames: [{ ok: true }, { pcm: "AAAA" }] },
      }),
    ).toThrow(/PCM/);
  });
});
