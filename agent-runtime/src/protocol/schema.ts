import { Type } from "typebox";
import { Compile } from "typebox/compile";

import { config } from "../config.js";
import { EVENT_SOURCES, REALTIME_EVENT_TYPES, type RealtimeEvent } from "./events.js";

/**
 * JSON Schema (via TypeBox) for the RealtimeEvent envelope. `additionalProperties`
 * is deliberately left open (not `false`): app/realtime/events.py's msgspec
 * `RealtimeEvent` struct silently ignores unrecognized top-level fields on
 * decode (msgspec's default -- verified directly, it does not raise), and the
 * plan's own interface contract says fields may be added without a migration.
 * A closed envelope here would make this side reject events the Python side
 * accepts, a silent cross-language break at exactly the WebSocket boundary
 * this schema is meant to guard. `payload` stays wide open (`Type.Unknown`)
 * since its shape varies per event type -- payload-level safety (no PCM,
 * bounded nesting) is enforced by `assertPayloadIsSafe` below, not by this
 * schema.
 */
export const RealtimeEventSchema = Type.Object({
  event_id: Type.String({ minLength: 1 }),
  sequence: Type.Integer({ minimum: 0 }),
  interaction_id: Type.Optional(Type.String({ minLength: 1 })),
  task_id: Type.Optional(Type.String({ minLength: 1 })),
  source: Type.Union(EVENT_SOURCES.map((value) => Type.Literal(value))),
  type: Type.Union(REALTIME_EVENT_TYPES.map((value) => Type.Literal(value))),
  timestamp: Type.String({ minLength: 1 }),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

/**
 * Compiled exactly once, at module load. Node's ESM module cache guarantees
 * every importer of this module shares this single compiled Validator --
 * recompiling a schema per-event is a hot-path performance violation and
 * must never happen.
 */
const validator = Compile(RealtimeEventSchema);

export class ProtocolValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProtocolValidationError";
  }
}

function describeErrors(value: unknown): string {
  const errors = [...validator.Errors(value)].slice(0, 5);
  if (errors.length === 0) {
    return "value did not match the RealtimeEvent schema";
  }
  return errors.map((error) => `${error.instancePath || "<root>"} ${error.message}`).join("; ");
}

/**
 * Keys that look like they carry raw PCM/audio bytes. This event protocol
 * must never be used to smuggle raw audio across the WebSocket boundary --
 * audio belongs to Pipecat's media pipeline, not the agent event log.
 */
const FORBIDDEN_PAYLOAD_KEY_PATTERN = /pcm|raw[_-]?audio/i;

/**
 * Walks a decoded payload to enforce two invariants that TypeBox's generic
 * `Type.Unknown()` value schema cannot express on its own:
 *   1. No field name anywhere in the payload may look like raw PCM/audio.
 *   2. The payload may not nest deeper than `config.maxPayloadDepth` (the
 *      payload root itself counts as depth 0).
 * This is plain recursive validation logic, not a schema recompilation, so
 * running it per-event does not violate the "compile once" constraint.
 */
function assertPayloadIsSafe(value: unknown, depth = 0, path = "payload"): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  if (depth > config.maxPayloadDepth) {
    throw new ProtocolValidationError(
      `payload exceeds the max nesting depth of ${config.maxPayloadDepth} at ${path}`,
    );
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPayloadIsSafe(item, depth + 1, `${path}[${index}]`));
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PAYLOAD_KEY_PATTERN.test(key)) {
      throw new ProtocolValidationError(
        `payload field "${path}.${key}" looks like raw PCM/audio data, which this event protocol must never carry`,
      );
    }
    assertPayloadIsSafe(nested, depth + 1, `${path}.${key}`);
  }
}

function assertEncodedSize(json: string): void {
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > config.maxEventBytes) {
    throw new ProtocolValidationError(
      `encoded event is ${bytes} bytes, exceeding the ${config.maxEventBytes}-byte limit`,
    );
  }
}

/** Validates and serializes a RealtimeEvent to the exact JSON wire format app/realtime/events.py decodes. */
export function encodeEvent(event: RealtimeEvent): string {
  if (!validator.Check(event)) {
    throw new ProtocolValidationError(`cannot encode an invalid RealtimeEvent: ${describeErrors(event)}`);
  }
  assertPayloadIsSafe(event.payload);

  const json = JSON.stringify(event);
  assertEncodedSize(json);
  return json;
}

/**
 * Validates and decodes a RealtimeEvent. Accepts either raw wire text (a
 * JSON string) or an already-parsed object, so callers on both the
 * WebSocket boundary and in tests can use it directly.
 */
export function decodeEvent(input: unknown): RealtimeEvent {
  let candidate: unknown = input;

  if (typeof input === "string") {
    assertEncodedSize(input);
    try {
      candidate = JSON.parse(input);
    } catch (cause) {
      throw new ProtocolValidationError("malformed JSON while decoding a RealtimeEvent", { cause });
    }
  }

  if (!validator.Check(candidate)) {
    throw new ProtocolValidationError(`invalid RealtimeEvent: ${describeErrors(candidate)}`);
  }

  const event = candidate as RealtimeEvent;
  assertPayloadIsSafe(event.payload);
  return event;
}
