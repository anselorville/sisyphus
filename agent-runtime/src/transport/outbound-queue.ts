import { config } from "../config.js";
import type { RealtimeEvent, RealtimeEventType } from "../protocol/events.js";

/** Delivery priority tiers, lowest to highest. Mirrors app/realtime/queueing.py's `EventPriority`. */
export enum EventPriority {
  COALESCIBLE = 0,
  DURABLE = 1,
  CRITICAL = 2,
}

/** Outcome of a single `push()` call. */
export type PushOutcome = "enqueued" | "coalesced" | "evicted" | "dropped";

export class QueueClosedError extends Error {
  constructor(message = "outbound event queue is closed") {
    super(message);
    this.name = "QueueClosedError";
  }
}

export class OutboundQueueOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundQueueOverflowError";
  }
}

/**
 * Event types that must preempt everything else in the outbound queue.
 * Matches the `voice.speech.cancel` floor in app/realtime/queueing.py's
 * `_protected_priority`.
 */
const CRITICAL_EVENT_TYPES: ReadonlySet<RealtimeEventType> = new Set(["voice.speech.cancel"]);

/**
 * Event types where only the newest instance matters: a later push may
 * replace an older, not-yet-sent queued instance in place rather than
 * growing the queue.
 */
const COALESCIBLE_EVENT_TYPES: ReadonlySet<RealtimeEventType> = new Set([
  "voice.transcript.partial",
  "task.progress",
]);

function classifyPriority(type: RealtimeEventType): EventPriority {
  if (CRITICAL_EVENT_TYPES.has(type)) {
    return EventPriority.CRITICAL;
  }
  if (COALESCIBLE_EVENT_TYPES.has(type)) {
    return EventPriority.COALESCIBLE;
  }
  // Durable by default: anything not explicitly marked safe to drop/coalesce
  // must be delivered, in order, exactly once.
  return EventPriority.DURABLE;
}

/** Dedup key for coalescible events: `type + task_id`, per spec. `undefined` for non-coalescible types. */
function coalesceKey(event: RealtimeEvent): string | undefined {
  if (!COALESCIBLE_EVENT_TYPES.has(event.type)) {
    return undefined;
  }
  return `${event.type}:${event.task_id ?? ""}`;
}

const DRAIN_ORDER = [EventPriority.CRITICAL, EventPriority.DURABLE, EventPriority.COALESCIBLE] as const;
const EVICTION_CANDIDATES = [EventPriority.COALESCIBLE, EventPriority.DURABLE] as const;

/**
 * Bounded, priority-ordered outbound queue for RealtimeEvents headed to
 * Python over the WebSocket transport (wired up in a later task).
 *
 * - Bounded capacity: never holds more than `capacity` events.
 * - Priority: CRITICAL always drains before DURABLE, before COALESCIBLE.
 * - Coalescing: `voice.transcript.partial` and `task.progress` events
 *   dedup on `type + task_id` -- a newer push replaces the older queued
 *   instance in place instead of growing the queue.
 * - Overflow policy: once full, a non-matching COALESCIBLE push is
 *   dropped; a DURABLE/CRITICAL push evicts the oldest strictly-lower-
 *   priority queued event to make room, or throws
 *   `OutboundQueueOverflowError` if no lower-priority event exists to
 *   evict.
 * - Close path: `close()` stops accepting new pushes (they throw
 *   `QueueClosedError`) while `shift()` keeps draining whatever is already
 *   queued.
 */
export class OutboundEventQueue {
  readonly capacity: number;
  private readonly buckets: Record<EventPriority, RealtimeEvent[]>;
  private readonly coalesced: Map<string, RealtimeEvent>;
  private closed = false;

  constructor(capacity: number = config.outboundQueueCapacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be an integer >= 1");
    }

    this.capacity = capacity;
    this.buckets = {
      [EventPriority.CRITICAL]: [],
      [EventPriority.DURABLE]: [],
      [EventPriority.COALESCIBLE]: [],
    };
    this.coalesced = new Map();
  }

  /** Total number of events currently queued across all priority tiers. */
  get size(): number {
    return (
      this.buckets[EventPriority.CRITICAL].length +
      this.buckets[EventPriority.DURABLE].length +
      this.buckets[EventPriority.COALESCIBLE].length
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Enqueues an event, applying coalescing and the overflow policy. Throws once the queue is closed. */
  push(event: RealtimeEvent): PushOutcome {
    if (this.closed) {
      throw new QueueClosedError();
    }

    const key = coalesceKey(event);
    if (key !== undefined) {
      const replaced = this.tryCoalesce(key, event);
      if (replaced) {
        return "coalesced";
      }
    }

    const priority = classifyPriority(event.type);

    if (this.size >= this.capacity) {
      if (priority === EventPriority.COALESCIBLE) {
        // Backpressure policy: never grow the queue for a droppable update:
        // the next partial/progress push will supersede it anyway.
        return "dropped";
      }
      if (this.evictLowerPriority(priority)) {
        this.append(event, priority, key);
        return "evicted";
      }
      throw new OutboundQueueOverflowError(
        `outbound event queue is full (capacity=${this.capacity}) and holds no lower-priority event to evict for a ${EventPriority[priority]} push`,
      );
    }

    this.append(event, priority, key);
    return "enqueued";
  }

  /** Removes and returns the highest-priority, oldest queued event, or `undefined` if the queue is empty. */
  shift(): RealtimeEvent | undefined {
    for (const priority of DRAIN_ORDER) {
      const bucket = this.buckets[priority];
      const event = bucket.shift();
      if (event !== undefined) {
        this.forgetCoalesceKey(event);
        return event;
      }
    }
    return undefined;
  }

  /** Stops accepting new pushes. Already-queued events remain available via `shift()`. */
  close(): void {
    this.closed = true;
  }

  private tryCoalesce(key: string, event: RealtimeEvent): boolean {
    const existing = this.coalesced.get(key);
    if (existing === undefined) {
      return false;
    }

    const bucket = this.buckets[EventPriority.COALESCIBLE];
    const index = bucket.indexOf(existing);
    if (index === -1) {
      // Stale index entry (should not normally happen); fall through to a
      // regular push instead of silently dropping the new event.
      this.coalesced.delete(key);
      return false;
    }

    bucket[index] = event;
    this.coalesced.set(key, event);
    return true;
  }

  private append(event: RealtimeEvent, priority: EventPriority, key: string | undefined): void {
    this.buckets[priority].push(event);
    if (key !== undefined) {
      this.coalesced.set(key, event);
    }
  }

  private evictLowerPriority(incoming: EventPriority): boolean {
    for (const candidate of EVICTION_CANDIDATES) {
      if (candidate >= incoming) {
        continue;
      }
      const bucket = this.buckets[candidate];
      const evicted = bucket.shift();
      if (evicted !== undefined) {
        this.forgetCoalesceKey(evicted);
        return true;
      }
    }
    return false;
  }

  private forgetCoalesceKey(event: RealtimeEvent): void {
    const key = coalesceKey(event);
    if (key !== undefined && this.coalesced.get(key) === event) {
      this.coalesced.delete(key);
    }
  }
}
