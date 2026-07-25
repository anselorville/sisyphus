/**
 * Task 17 integration tests: the first time the whole composed runtime
 * (src/index.ts's createAgentRuntime()) runs as one coherent process.
 *
 * Every test here uses a real DatabaseClient (a real Worker Thread, a real
 * SQLite file on disk) and a real RuntimeWebSocketServer (a real `ws`
 * client connects over a real loopback socket) -- only the Pi Session layer
 * is faked (see FakePiSession below), since nothing in these tests ever
 * prompts a role and real Pi/LLM credentials are not expected to be
 * configured in this environment.
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
import type { AckMessage } from "../../src/transport/websocket-server.js";

/** Never touches a real Pi backend -- mirrors test/roles/session-manager.test.ts's FakePiSession. Nothing in these tests ever calls ensure()/prompt(), so its methods are never actually exercised; it only needs to satisfy the PiSession shape so PiRoleSessionManager can be constructed. */
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

const fakePiSessionProvider: PiSessionProvider = async (): Promise<PiSession> => new FakePiSession();

let tempDir: string;
let eventCounter = 0;
const openRuntimes: AgentRuntime[] = [];
const openClients: WebSocket[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-recovery-test-"));
});

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    client.close();
  }
  // close() is idempotent on every constituent piece, so it is always safe
  // to call here even for a runtime a test already tore down by hand.
  await Promise.all(openRuntimes.splice(0).map((runtime) => runtime.close()));
  await rm(tempDir, { recursive: true, force: true });
});

function nextDbPath(): string {
  return join(tempDir, `test-${randomUUID()}.sqlite3`);
}

function makeTranscriptFinalEvent(overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  eventCounter += 1;
  return {
    event_id: `evt-${eventCounter}`,
    sequence: eventCounter,
    interaction_id: "conv-1",
    source: "pipecat",
    type: "voice.transcript.final",
    timestamp: new Date(0).toISOString(),
    payload: { text: "check the project tests, then email me the result" },
    ...overrides,
  };
}

function once<T = unknown>(target: WebSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    target.once(event, (arg: T) => resolve(arg));
  });
}

async function connectClient(port: number): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, "open");
  return client;
}

function parseAck(raw: unknown): AckMessage {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return JSON.parse(text) as AckMessage;
}

async function startRuntime(overrides: Parameters<typeof createAgentRuntime>[0] = {}): Promise<AgentRuntime> {
  const runtime = await createAgentRuntime({
    dbPath: nextDbPath(),
    port: 0,
    piSessionProvider: fakePiSessionProvider,
    ...overrides,
  });
  openRuntimes.push(runtime);
  return runtime;
}

describe("composition root smoke test", () => {
  it("starts, binds a real port, routes an inbound transcript into the Task Nest, acks it, and shuts down cleanly", async () => {
    const runtime = await startRuntime();

    expect(runtime.server.address).toBeDefined();
    expect(runtime.server.address?.port).toBeGreaterThan(0);

    const client = await connectClient(runtime.server.address!.port);
    openClients.push(client);

    const event = makeTranscriptFinalEvent();
    const ackPromise = once<Buffer>(client, "message");
    client.send(encodeEvent(event));
    const ack = parseAck(await ackPromise);

    expect(ack).toEqual({ kind: "ack", sequence: event.sequence, duplicate: false });

    // RuntimeWebSocketServer.handleInboundMessage() awaits onInboundEvent
    // before it ever sends the ack (see websocket-server.ts) -- our
    // composed handler awaits taskNest.create() -- so by the time the ack
    // above resolved, the task is already both in memory and durable.
    expect(runtime.taskNest.size).toBe(1);

    const { tasks } = await runtime.db.request({ type: "task.list-active" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.goal).toBe("check the project tests, then email me the result");
    expect(tasks[0]?.interaction_id).toBe("conv-1");
    expect(tasks[0]?.status).toBe("pending");

    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("ignores non-transcript events (never creates a task) but still acks them", async () => {
    const runtime = await startRuntime();
    const client = await connectClient(runtime.server.address!.port);
    openClients.push(client);

    const event = makeTranscriptFinalEvent({ type: "voice.user.started", payload: {} });
    const ackPromise = once<Buffer>(client, "message");
    client.send(encodeEvent(event));
    await ackPromise;

    expect(runtime.taskNest.size).toBe(0);
  });
});

describe("crash recovery", () => {
  it("recovers a pending task exactly once after a simulated hard crash and restart against the same db", async () => {
    const dbPath = nextDbPath();

    const runtimeA = await startRuntime({ dbPath });
    const clientA = await connectClient(runtimeA.server.address!.port);
    openClients.push(clientA);

    const event = makeTranscriptFinalEvent({
      interaction_id: "conv-recover",
      payload: { text: "send the report to my inbox" },
    });
    const ackPromise = once<Buffer>(clientA, "message");
    clientA.send(encodeEvent(event));
    await ackPromise;

    expect(runtimeA.taskNest.size).toBe(1);
    const { tasks: activeBefore } = await runtimeA.db.request({ type: "task.list-active" });
    expect(activeBefore).toHaveLength(1);
    const taskId = activeBefore[0]!.id;

    // "Crash": tear down the DB Worker directly, WITHOUT going through
    // runtimeA.close()'s graceful, ordered shutdown (no
    // acceptingInboundWork flip, no stopping metrics first, no
    // sessionManager/rpcChamber close before the db) -- simulating a hard
    // process kill that never ran any shutdown hook at all. The remaining
    // pieces are only closed here because this test, unlike a real crash,
    // shares one OS process across every test in this file and must not
    // leak the WebSocket port or the worker thread into later tests.
    clientA.close();
    await runtimeA.db.close();
    await runtimeA.server.close();
    await runtimeA.sessionManager.close();
    await runtimeA.rpcChamber.close();

    // Restart: a brand-new runtime instance against the SAME db path.
    // recoverPending() runs automatically during createAgentRuntime()'s
    // startup (see src/index.ts's autoRecoverPending, default true).
    const runtimeB = await startRuntime({ dbPath });

    expect(runtimeB.recoveredTasks.map((task) => task.id)).toEqual([taskId]);
    expect(runtimeB.recoveredTasks[0]?.goal).toBe("send the report to my inbox");
    expect(runtimeB.recoveredTasks[0]?.interactionId).toBe("conv-recover");
    expect(runtimeB.recoveredTasks[0]?.status).toBe("pending");
    expect(runtimeB.taskNest.get(taskId)?.status).toBe("pending");
    expect(runtimeB.taskNest.size).toBe(1);

    // Recovered exactly once: calling recoverPending() again must not
    // duplicate anything (TaskNest's in-memory map is keyed by task id, and
    // the row is still the only active one in SQLite).
    const recoveredAgain = await runtimeB.taskNest.recoverPending();
    expect(recoveredAgain.map((task) => task.id)).toEqual([taskId]);
    expect(runtimeB.taskNest.size).toBe(1);

    await runtimeB.close();
  });

  it("does not recover anything once a task has already reached a terminal state before the crash", async () => {
    const dbPath = nextDbPath();

    const runtimeA = await startRuntime({ dbPath });
    const task = await runtimeA.taskNest.create({ goal: "a task that finishes before the crash", interactionId: "conv-done" });
    await runtimeA.taskNest.transition(task.id, "completed");

    await runtimeA.db.close();
    await runtimeA.server.close();
    await runtimeA.sessionManager.close();
    await runtimeA.rpcChamber.close();

    const runtimeB = await startRuntime({ dbPath });

    expect(runtimeB.recoveredTasks).toEqual([]);
    expect(runtimeB.taskNest.get(task.id)).toBeUndefined();

    await runtimeB.close();
  });
});
