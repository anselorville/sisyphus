/**
 * Integration tests for the TaskExecutor orchestration loop — the three
 * QA scenarios from the task spec: basic voice loop, LLM failure, and
 * task cancellation. Uses createAgentRuntime() with fake PiSessionProviders
 * (echo / throw / delay) so nothing touches a real LLM backend.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentRuntime, type AgentRuntime } from "../../src/index.js";
import type { RealtimeEvent } from "../../src/protocol/events.js";
import type { PiSession, PiSessionProvider } from "../../src/roles/types.js";

// --- event helpers (mirror session-manager.test.ts patterns) -------------

function textDelta(delta: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { role: "assistant", content: [] } },
  } as unknown as AgentSessionEvent;
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;
const AGENT_END = { type: "agent_end", willRetry: false } as unknown as AgentSessionEvent;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- fake PiSessions -------------------------------------------------------

class EchoPiSession implements PiSession {
  readonly messages: readonly unknown[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async prompt(text: string): Promise<void> {
    this.emit(AGENT_START);
    this.emit(textDelta(`收到：${text}`));
    await delay(100);
    this.emit(AGENT_END);
  }

  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  dispose(): void { this.listeners.clear(); }

  private emit(event: AgentSessionEvent): void {
    for (const l of this.listeners) { l(event); }
  }
}

class ThrowPiSession implements PiSession {
  readonly messages: readonly unknown[] = [];
  subscribe(): () => void { return () => {}; }
  async prompt(): Promise<void> { throw new Error("LLM unavailable"); }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  dispose(): void {}
}

class DelayPiSession implements PiSession {
  readonly messages: readonly unknown[] = [];
  aborted = false;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async prompt(text: string): Promise<void> {
    this.emit(AGENT_START);
    await delay(2000);
    if (!this.aborted) {
      this.emit(textDelta("late response"));
      await delay(100);
      this.emit(AGENT_END);
    }
  }

  async abort(): Promise<void> { this.aborted = true; this.listeners.clear(); }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  dispose(): void { this.listeners.clear(); }

  private emit(event: AgentSessionEvent): void {
    for (const l of this.listeners) { l(event); }
  }
}

// --- test setup -----------------------------------------------------------

let tempDir: string;
const openRuntimes: AgentRuntime[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "task-executor-test-"));
});

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((r) => r.close()));
  await rm(tempDir, { recursive: true, force: true });
});

function nextDbPath(): string {
  return join(tempDir, `test-${randomUUID()}.sqlite3`);
}

type SessionTracker = Map<string, EchoPiSession | ThrowPiSession | DelayPiSession>;

function makeTrackedProvider<T extends PiSession>(
  factory: () => T,
  tracker: SessionTracker,
): PiSessionProvider {
  return async (manifest) => {
    const session = factory();
    tracker.set(manifest.id, session as unknown as EchoPiSession | ThrowPiSession | DelayPiSession);
    return session;
  };
}

async function startRuntime(provider: PiSessionProvider): Promise<AgentRuntime> {
  const runtime = await createAgentRuntime({
    dbPath: nextDbPath(),
    port: 0,
    piSessionProvider: provider,
  });
  openRuntimes.push(runtime);
  return runtime;
}

function captureBroadcasts(runtime: AgentRuntime): RealtimeEvent[] {
  const events: RealtimeEvent[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runtime.server as any).broadcast = (event: RealtimeEvent) => { events.push(event); };
  return events;
}

async function waitForStatus(
  runtime: AgentRuntime,
  taskId: string,
  status: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = runtime.taskNest.get(taskId);
    if (record?.status === status) {
      return;
    }
    await delay(30);
  }
  const final = runtime.taskNest.get(taskId);
  throw new Error(`task ${taskId} expected "${status}", got "${final?.status ?? "missing"}"`);
}

async function waitForSpeech(
  events: RealtimeEvent[],
  contains?: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const speech = events.filter((e) => e.type === "voice.speech.enqueue");
    if (
      speech.length > 0 &&
      (!contains || speech.some((e) => String(e.payload["text"] ?? "").includes(contains)))
    ) {
      return;
    }
    await delay(30);
  }
  throw new Error(`no speech broadcast${contains ? ` containing "${contains}"` : ""} within ${timeoutMs}ms`);
}

// --- QA scenarios ---------------------------------------------------------

describe("TaskExecutor orchestration loop", () => {
  it("basic voice loop: transcript → task.completed with speech containing the response", async () => {
    const tracker: SessionTracker = new Map();
    const runtime = await startRuntime(makeTrackedProvider(() => new EchoPiSession(), tracker));
    const broadcasts = captureBroadcasts(runtime);

    const taskId = await runtime.taskExecutor.onVoiceTranscript("你好", "conv-1");
    expect(taskId).toBeDefined();
    await waitForStatus(runtime, taskId!, "completed");

    const task = runtime.taskNest.get(taskId!);
    expect(task?.status).toBe("completed");

    await waitForSpeech(broadcasts, "你好");
    const speech = broadcasts.filter((e) => e.type === "voice.speech.enqueue");
    const hasResponse = speech.some(
      (e) => typeof e.payload["text"] === "string" && (e.payload["text"] as string).includes("你好"),
    );
    expect(hasResponse).toBe(true);
  });

  it("LLM failure: prompt throws → task.failed with error speech", async () => {
    const runtime = await startRuntime(async () => new ThrowPiSession());
    const broadcasts = captureBroadcasts(runtime);

    const taskId = await runtime.taskExecutor.onVoiceTranscript("test", "conv-2");
    expect(taskId).toBeDefined();
    await waitForStatus(runtime, taskId!, "failed");

    const task = runtime.taskNest.get(taskId!);
    expect(task?.status).toBe("failed");

    await waitForSpeech(broadcasts);
    expect(broadcasts.some((e) => e.type === "voice.speech.enqueue")).toBe(true);
  });

  it("task cancellation: stop phrase aborts the active task", async () => {
    const tracker: SessionTracker = new Map();
    const runtime = await startRuntime(makeTrackedProvider(() => new DelayPiSession(), tracker));

    const taskId = await runtime.taskExecutor.onVoiceTranscript("test", "conv-3");
    expect(taskId).toBeDefined();
    expect(runtime.taskNest.get(taskId!)?.status).toBe("running");

    await delay(200);
    const cancelResult = await runtime.taskExecutor.onVoiceTranscript("停", "conv-3");
    expect(cancelResult).toBeUndefined();

    await waitForStatus(runtime, taskId!, "cancelled", 3000);

    const task = runtime.taskNest.get(taskId!);
    expect(task?.status).toBe("cancelled");

    const delaySession = tracker.get("general") as DelayPiSession | undefined;
    expect(delaySession?.aborted).toBe(true);
  });
});
