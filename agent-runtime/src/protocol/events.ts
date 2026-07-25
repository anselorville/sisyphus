/**
 * Wire-level shape of the RealtimeEvent envelope shared with the Python
 * Pipecat pipeline (see app/realtime/events.py's msgspec `RealtimeEvent`
 * struct). Field names are intentionally snake_case to match the JSON that
 * crosses the WebSocket boundary byte-for-byte -- do not camelCase these.
 *
 * This module is a dependency-free leaf: it only declares the shape of the
 * protocol. Compiled validation and encode/decode live in ./schema.ts.
 */

/** Every source allowed to emit a RealtimeEvent. */
export const EVENT_SOURCES = ["pipecat", "swarm", "pi", "tool", "system"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** Every RealtimeEvent type currently defined by the protocol. */
export const REALTIME_EVENT_TYPES = [
  "voice.user.started",
  "voice.user.stopped",
  "voice.transcript.partial",
  "voice.transcript.final",
  "voice.speech.enqueue",
  "voice.speech.cancel",
  "task.created",
  "task.assigned",
  "task.progress",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.steer",
  "task.follow_up",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "diplomacy.elevation.requested",
  "diplomacy.elevation.resolved",
  "budget.updated",
  "ecology.state.changed",
  "role.birth.requested",
  "role.hatched",
  "role.slept",
  "role.retired",
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/**
 * The RealtimeEvent envelope. Never carries raw PCM/audio bytes in
 * `payload` -- that constraint is enforced at decode/encode time in
 * ./schema.ts, since it cannot be expressed as a static TS type.
 */
export interface RealtimeEvent<T = Record<string, unknown>> {
  event_id: string;
  sequence: number;
  interaction_id?: string;
  task_id?: string;
  source: EventSource;
  type: RealtimeEventType;
  timestamp: string;
  payload: T;
}
