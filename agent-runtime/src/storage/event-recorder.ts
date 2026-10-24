/**
 * Persists every RealtimeEvent the transport observes into the `events` table
 * (via the DB Worker's `event.record` command), so HCI data -- latency between
 * `voice.user.stopped` and the first `voice.speech.enqueue`, how often
 * `voice.speech.cancel` interrupts, how tasks were routed, what the transcript
 * said -- survives the process and is queryable by scripts/query-hci-events.sh.
 *
 * Fire-and-forget on purpose: the voice path must never wait on, or fail
 * because of, an observability write. `record()` returns immediately; a failed
 * write is reported once through `onError` and otherwise dropped. Writes to a
 * DB that is already closing (shutdown races) are dropped silently.
 */

import type { RealtimeEvent } from "../protocol/events.js";
import { DatabaseClientClosedError, type DatabaseClient } from "./database.js";

export interface EventRecorderOptions {
  readonly db: DatabaseClient;
  /** Injectable clock for `received_at`. Default: the real wall clock. */
  readonly now?: () => Date;
  /** Called with each write failure other than a closed-DB shutdown race. Default: console.warn. */
  readonly onError?: (error: unknown, event: RealtimeEvent) => void;
}

export class EventRecorder {
  private readonly db: DatabaseClient;
  private readonly now: () => Date;
  private readonly onError: (error: unknown, event: RealtimeEvent) => void;

  constructor(options: EventRecorderOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.onError =
      options.onError ??
      ((error, event) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[event-recorder] failed to record ${event.type} (${event.event_id}): ${message}`);
      });
  }

  record(event: RealtimeEvent): void {
    const receivedAt = this.now().toISOString();
    this.db
      .request({
        type: "event.record",
        event: {
          eventId: event.event_id,
          sequence: event.sequence,
          interactionId: event.interaction_id ?? null,
          taskId: event.task_id ?? null,
          source: event.source,
          type: event.type,
          timestamp: event.timestamp,
          payload: JSON.stringify(event.payload),
          receivedAt,
        },
      })
      .catch((error: unknown) => {
        if (error instanceof DatabaseClientClosedError) {
          return;
        }
        this.onError(error, event);
      });
  }
}
