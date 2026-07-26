import { describe, expect, it } from "vitest";

import { config } from "../../src/config.js";
import type { RealtimeEvent } from "../../src/protocol/events.js";
import {
  OutboundEventQueue,
  OutboundQueueOverflowError,
  QueueClosedError,
} from "../../src/transport/outbound-queue.js";

let counter = 0;

function makeEvent(overrides: Partial<RealtimeEvent> & Pick<RealtimeEvent, "type">): RealtimeEvent {
  counter += 1;
  return {
    event_id: `evt-${counter}`,
    sequence: counter,
    source: "swarm",
    timestamp: new Date(0).toISOString(),
    payload: {},
    ...overrides,
  };
}

function progressEvent(taskId: string, payload: Record<string, unknown> = {}): RealtimeEvent {
  return makeEvent({ type: "task.progress", task_id: taskId, payload });
}

function cancelEvent(): RealtimeEvent {
  return makeEvent({ type: "voice.speech.cancel" });
}

function finalEvent(taskId: string): RealtimeEvent {
  return makeEvent({ type: "task.completed", task_id: taskId });
}

function createdEvent(taskId: string): RealtimeEvent {
  return makeEvent({ type: "task.created", task_id: taskId });
}

describe("OutboundEventQueue construction", () => {
  it("defaults to the configured capacity of 1024", () => {
    const queue = new OutboundEventQueue();

    expect(queue.capacity).toBe(1024);
    expect(queue.capacity).toBe(config.outboundQueueCapacity);
  });

  it.each([0, -1, 1.5])("rejects a non-positive-integer capacity (%s)", (capacity) => {
    expect(() => new OutboundEventQueue(capacity)).toThrow(RangeError);
  });
});

describe("priority ordering", () => {
  it("returns undefined when shifting an empty queue", () => {
    const queue = new OutboundEventQueue(4);

    expect(queue.shift()).toBeUndefined();
  });

  it("drains same-priority events in FIFO order", () => {
    const queue = new OutboundEventQueue(4);
    queue.push(finalEvent("t1"));
    queue.push(finalEvent("t2"));

    expect(queue.shift()?.task_id).toBe("t1");
    expect(queue.shift()?.task_id).toBe("t2");
  });

  it("critical events preempt coalescible events", () => {
    const queue = new OutboundEventQueue(2);
    queue.push(progressEvent("old"));
    queue.push(cancelEvent());

    expect(queue.shift()?.type).toBe("voice.speech.cancel");
  });

  it("drains critical, then durable, then coalescible", () => {
    const queue = new OutboundEventQueue(4);
    queue.push(progressEvent("t1"));
    queue.push(finalEvent("t2"));
    queue.push(cancelEvent());

    expect(queue.shift()?.type).toBe("voice.speech.cancel");
    expect(queue.shift()?.type).toBe("task.completed");
    expect(queue.shift()?.type).toBe("task.progress");
    expect(queue.shift()).toBeUndefined();
  });

  it("classifies unlisted event types as durable by default", () => {
    const queue = new OutboundEventQueue(4);
    queue.push(progressEvent("t1"));
    queue.push(createdEvent("t2"));

    expect(queue.shift()?.type).toBe("task.created");
    expect(queue.shift()?.type).toBe("task.progress");
  });
});

describe("coalescing", () => {
  it('returns "enqueued" for a fresh, non-coalescing push', () => {
    const queue = new OutboundEventQueue(4);

    expect(queue.push(finalEvent("t1"))).toBe("enqueued");
  });

  it("coalesces partial/progress events sharing type + task_id instead of growing the queue", () => {
    const queue = new OutboundEventQueue(4);
    queue.push(progressEvent("t1", { percent: 10 }));
    const outcome = queue.push(progressEvent("t1", { percent: 50 }));

    expect(outcome).toBe("coalesced");
    expect(queue.size).toBe(1);
    expect(queue.shift()?.payload).toEqual({ percent: 50 });
  });

  it("does not coalesce progress events with different task_id", () => {
    const queue = new OutboundEventQueue(4);
    queue.push(progressEvent("t1"));
    queue.push(progressEvent("t2"));

    expect(queue.size).toBe(2);
  });

  it("does not coalesce across different coalescible types sharing a task_id", () => {
    const queue = new OutboundEventQueue(4);
    queue.push(makeEvent({ type: "voice.transcript.partial", task_id: "t1", payload: {} }));
    queue.push(progressEvent("t1"));

    expect(queue.size).toBe(2);
  });

  it("keeps a coalesced replacement in its original FIFO position", () => {
    const queue = new OutboundEventQueue(10);
    queue.push(progressEvent("t1", { percent: 10 }));
    queue.push(progressEvent("t2", { percent: 10 }));
    queue.push(progressEvent("t1", { percent: 90 }));

    const first = queue.shift();
    expect(first?.task_id).toBe("t1");
    expect(first?.payload).toEqual({ percent: 90 });

    const second = queue.shift();
    expect(second?.task_id).toBe("t2");
  });
});

describe("overflow policy", () => {
  it("drops a non-matching coalescible push when the queue is full", () => {
    const queue = new OutboundEventQueue(1);
    queue.push(finalEvent("t1"));

    const outcome = queue.push(progressEvent("t2"));

    expect(outcome).toBe("dropped");
    expect(queue.size).toBe(1);
    expect(queue.shift()?.task_id).toBe("t1");
    expect(queue.shift()).toBeUndefined();
  });

  it("evicts the oldest lower-priority event to admit a critical push when full", () => {
    const queue = new OutboundEventQueue(2);
    queue.push(progressEvent("t1"));
    queue.push(progressEvent("t2"));

    const outcome = queue.push(cancelEvent());

    expect(outcome).toBe("evicted");
    expect(queue.size).toBe(2);
    expect(queue.shift()?.type).toBe("voice.speech.cancel");
    expect(queue.shift()?.task_id).toBe("t2");
  });

  it("throws OutboundQueueOverflowError when full and nothing lower-priority can be evicted", () => {
    const queue = new OutboundEventQueue(2);
    queue.push(finalEvent("t1"));
    queue.push(finalEvent("t2"));

    expect(() => queue.push(finalEvent("t3"))).toThrow(OutboundQueueOverflowError);
    expect(queue.size).toBe(2);
  });
});

describe("close path", () => {
  it("rejects new pushes once closed", () => {
    const queue = new OutboundEventQueue(4);
    queue.close();

    expect(queue.isClosed).toBe(true);
    expect(() => queue.push(cancelEvent())).toThrow(QueueClosedError);
  });

  it("still drains already-queued events after close", () => {
    const queue = new OutboundEventQueue(4);
    queue.push(finalEvent("t1"));
    queue.push(cancelEvent());
    queue.close();

    expect(queue.shift()?.type).toBe("voice.speech.cancel");
    expect(queue.shift()?.type).toBe("task.completed");
    expect(queue.shift()).toBeUndefined();
  });
});
