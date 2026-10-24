import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RealtimeEvent } from "../../src/protocol/events.js";
import { DatabaseClient } from "../../src/storage/database.js";
import { EventRecorder } from "../../src/storage/event-recorder.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-event-recorder-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function openDb(): Promise<DatabaseClient> {
  return DatabaseClient.open(join(tempDir, `${randomUUID()}.sqlite3`));
}

function makeEvent(overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    event_id: randomUUID(),
    sequence: 1,
    source: "pipecat",
    type: "voice.transcript.final",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { text: "你好" },
    ...overrides,
  };
}

describe("EventRecorder", () => {
  it("maps an envelope onto an events row, stamping received_at from the injected clock", async () => {
    const db = await openDb();
    const recorder = new EventRecorder({ db, now: () => new Date("2026-02-03T04:05:06.000Z") });
    const event = makeEvent({ interaction_id: "i-1", task_id: "t-1", payload: { text: "你好", n: 2 } });

    recorder.record(event);

    const { events } = await db.request({ type: "event.list", limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_id: event.event_id,
      interaction_id: "i-1",
      task_id: "t-1",
      source: "pipecat",
      type: "voice.transcript.final",
      received_at: "2026-02-03T04:05:06.000Z",
    });
    expect(JSON.parse(events[0]!.payload)).toEqual({ text: "你好", n: 2 });
    await db.close();
  });

  it("stores absent interaction_id / task_id as NULL", async () => {
    const db = await openDb();
    new EventRecorder({ db }).record(makeEvent());

    const { events } = await db.request({ type: "event.list", limit: 5 });
    expect(events[0]?.interaction_id).toBeNull();
    expect(events[0]?.task_id).toBeNull();
    await db.close();
  });

  it("returns synchronously without throwing and swallows silently once the DB is closed", async () => {
    const db = await openDb();
    await db.close();
    const onError = vi.fn();
    const recorder = new EventRecorder({ db, onError });

    expect(() => recorder.record(makeEvent())).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports other write failures through onError instead of throwing", async () => {
    const db = await openDb();
    const failure = new Error("disk full");
    vi.spyOn(db, "request").mockRejectedValue(failure);
    const onError = vi.fn();
    const event = makeEvent();

    new EventRecorder({ db, onError }).record(event);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure, event));
    vi.restoreAllMocks();
    await db.close();
  });
});
