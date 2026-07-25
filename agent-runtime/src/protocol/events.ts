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

/**
 * Every RealtimeEvent type currently defined by the protocol.
 *
 * `tool.progress` was added by a later audit pass: app/realtime/queueing.py
 * (Python) has used it since that module was first built, as a real,
 * tested COALESCIBLE event type (a tool-execution-level progress update,
 * distinct from task-level `task.progress`) -- but it was never added to
 * this union, so decodeEvent()/the compiled TypeBox schema would have
 * silently rejected every such event a real Python process ever sent.
 * Deliberately NOT added to ./transport/outbound-queue.ts's
 * COALESCIBLE_EVENT_TYPES: Python's own coalescing key for this type is
 * `(task_id, payload.tool)`, finer-grained than this queue's generic
 * `type + task_id` key, and nothing on the TypeScript side currently
 * produces this event type in the sidecar->Python direction -- so it
 * defaults to DURABLE (safe: never dropped, never wrongly merges two
 * different tools' progress under one key) rather than risk a mismatched
 * coalesce for a not-yet-exercised path.
 */
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
  "tool.progress",
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
