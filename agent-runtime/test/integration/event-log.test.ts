/**
 * The HCI event log end to end: a real composed runtime (real Worker Thread,
 * real SQLite file, real loopback WebSocket; only the Pi Session is faked)
 * must persist both what Pipecat sends in and what the runtime sends out, so
 * scripts/query-hci-events.sh has data to read.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentRuntime, type AgentRuntime } from "../../src/index.js";
import type { RealtimeEvent } from "../../src/protocol/events.js";
import { encodeEvent } from "../../src/protocol/schema.js";
import type { PiSession, PiSessionProvider } from "../../src/roles/types.js";

class FakePiSession implements PiSession {
  readonly messages: readonly unknown[] = [];
  subscribe(): () => void {
    return (): void => {};
  }
  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  dispose(): void {}
}

const fakeProvider: PiSessionProvider = async (): Promise<PiSession> => new FakePiSession();

let tempDir: string;
const runtimes: AgentRuntime[] = [];
const clients: WebSocket[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-event-log-test-"));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await rm(tempDir, { recursive: true, force: true });
});

describe("HCI event log", () => {
  it("records the inbound transcript and the runtime's own outbound events in the events table", async () => {
    const runtime = await createAgentRuntime({
      dbPath: join(tempDir, `${randomUUID()}.sqlite3`),
      port: 0,
      piSessionProvider: fakeProvider,
    });
    runtimes.push(runtime);

    const client = new WebSocket(`ws://127.0.0.1:${runtime.server.address!.port}`);
    clients.push(client);
    await new Promise((resolve) => client.once("open", resolve));

    const inbound: RealtimeEvent = {
      event_id: randomUUID(),
      sequence: 1,
      interaction_id: "conv-hci",
      source: "pipecat",
      type: "voice.transcript.final",
      timestamp: new Date().toISOString(),
      payload: { text: "帮我查一下今天的天气" },
    };
    client.send(encodeEvent(inbound));

    // Poll the table rather than assuming ordering: recording is deliberately fire-and-forget.
    let types: string[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { events } = await runtime.db.request({ type: "event.list", limit: 50 });
      types = events.map((e) => e.type);
      if (types.includes("voice.transcript.final") && types.includes("task.created")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const { events } = await runtime.db.request({ type: "event.list", limit: 50 });
    const recordedInbound = events.find((e) => e.event_id === inbound.event_id);
    expect(recordedInbound).toMatchObject({
      source: "pipecat",
      type: "voice.transcript.final",
      interaction_id: "conv-hci",
    });
    expect(JSON.parse(recordedInbound!.payload)).toEqual({ text: "帮我查一下今天的天气" });

    const created = events.find((e) => e.type === "task.created");
    expect(created, `expected a task.created event, saw: ${types.join(", ")}`).toBeDefined();
    expect(created!.task_id).toBeTruthy();
    expect(created!.source).not.toBe("pipecat");
    // Each event is logged exactly once even though one connection is attached.
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    // The Python bridge de-duplicates sidecar events by `sequence` alone, so
    // everything the runtime originates must carry a unique one.
    const outbound = events.filter((e) => e.source !== "pipecat");
    expect(outbound.length).toBeGreaterThan(1);
    expect(new Set(outbound.map((e) => e.sequence)).size).toBe(outbound.length);
  });
});
