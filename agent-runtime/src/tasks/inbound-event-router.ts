/**
 * Inbound Event Router: the one piece of real integration logic Task 17's
 * composition root (../index.ts) adds on top of everything Tasks 7-16
 * already built. Translates an inbound `voice.transcript.final`
 * RealtimeEvent -- arriving through RuntimeWebSocketServer's
 * `onInboundEvent` seam (../transport/websocket-server.ts) -- into a
 * durable TaskNest.create() call (../tasks/task-nest.ts).
 *
 * Every other RealtimeEventType is a no-op here: routing an in-flight
 * task's steer/follow-up/cancel phrases is ReflexRouter's job
 * (../routing/reflex-router.ts), not this module's. Kept in its own file
 * rather than inline in ../index.ts -- the plan's Global Constraints are
 * explicit that no business logic belongs in the entry file, and this is
 * the one deliberate, spec-sanctioned exception, so it gets a real,
 * documented, single-purpose, independently-testable home instead of living
 * as an anonymous closure buried inside the composition root's wiring.
 */

import type { RealtimeEvent } from "../protocol/events.js";
import type { TaskNest } from "./task-nest.js";

export interface InboundEventRouterOptions {
  /**
   * Called whenever a `voice.transcript.final` event is ignored because its
   * payload carries no usable `text` field. Diagnostics only -- mirrors
   * RuntimeWebSocketServer's own "a handler failure/no-op never blocks the
   * ack" contract; this never throws.
   */
  readonly onIgnored?: (event: RealtimeEvent, reason: string) => void;
}

/** Reads the one field this router needs from an untyped payload, without assuming any other shape is present. */
function readTranscriptText(payload: Record<string, unknown>): string | undefined {
  const text = payload["text"];
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
}

/**
 * Builds the `RuntimeWebSocketServerOptions["onInboundEvent"]` handler that
 * feeds `voice.transcript.final` events into `taskNest`. `interaction_id` is
 * optional on the wire (../protocol/events.ts's RealtimeEvent); when an event
 * carries none, this falls back to the transport-level `connectionId` so
 * every created task still groups under *some* stable interaction id.
 */
export function createInboundEventRouter(
  taskNest: TaskNest,
  options: InboundEventRouterOptions = {},
): (event: RealtimeEvent, connectionId: string) => Promise<void> {
  return async (event, connectionId) => {
    if (event.type !== "voice.transcript.final") {
      return;
    }

    const text = readTranscriptText(event.payload);
    if (text === undefined) {
      options.onIgnored?.(event, "payload.text is missing or empty");
      return;
    }

    await taskNest.create({
      goal: text,
      interactionId: event.interaction_id ?? connectionId,
      metadata: { sourceEventId: event.event_id },
    });
  };
}
