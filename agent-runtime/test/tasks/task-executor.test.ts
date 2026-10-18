/**
 * TaskExecutor tests: verify the full orchestration loop
 * (voice.transcript.final -> ReflexRouter -> prompt -> VoiceHerald ->
 * WebSocket -> taskNest.transition) against three fake PiSessionProvider
 * modes (echo, throw, delay) matching the task's QA scenarios.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseClient } from "../../src/storage/database.js";
import { TaskNest } from "../../src/tasks/task-nest.js";
import { TaskExecutor } from "../../src/tasks/task-executor.js";
import { RoleManifestRegistry } from "../../src/roles/registry.js";
import { PiRoleSessionManager } from "../../src/roles/session-manager.js";
import { GENERAL_ROLE_MANIFEST, WEB_ROLE_MANIFEST } from "../../src/roles/manifests.js";
import type { PiSession, PiSessionProvider } from "../../src/roles/types.js";
import { ReflexRouter } from "../../src/routing/reflex-router.js";
import { TrafficCommander } from "../../src/voice/traffic-commander.js";
import { VoiceHerald } from "../../src/voice/voice-herald.js";
import type { RealtimeEvent } from "../../src/protocol/events.js";
import type { RuntimeWebSocketServer } from "../../src/transport/websocket-server.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textDeltaEvent(delta: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { role: "assistant", content: [] } },
  } as unknown as AgentSessionEvent;
}

function agentStartEvent(): AgentSessionEvent {
  return { type: "agent_start" } as unknown as AgentSessionEvent;
}

function agentEndEvent(): AgentSessionEvent {
  return { type: "agent_end", willRetry: false } as unknown as AgentSessionEvent;
}

function toolStartEvent(toolName: string): AgentSessionEvent {
  return {
    type: "tool_execution_start",
    toolCallId: "tool-call-1",
    toolName,
    args: {},
  } as unknown as AgentSessionEvent;
}

function toolEndEvent(toolName: string): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId: "tool-call-1",
    toolName,
    result: "done",
    isError: false,
  } as unknown as AgentSessionEvent;
}

abstract class TestPiSession implements PiSession {
  protected readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly messages: readonly unknown[] = [];
  abstract prompt(text: string): Promise<void>;
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  dispose(): void {
    this.listeners.clear();
  }
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  protected emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class EchoPiSession extends TestPiSession {
  readonly promptedTexts: string[] = [];
  async prompt(text: string): Promise<void> {
    this.promptedTexts.push(text);
    this.emit(agentStartEvent());
    await delay(10);
    this.emit(textDeltaEvent("你好，我是JARVIS语音助手。"));
    await delay(10);
    this.emit(agentEndEvent());
  }
}

class LongAnswerPiSession extends TestPiSession {
  async prompt(): Promise<void> {
    this.emit(agentStartEvent());
    await delay(10);
    this.emit(textDeltaEvent("飞书是一款企业协作平台，支持即时通讯、在线文档、日历、审批和音视频会议。".repeat(8)));
    this.emit(agentEndEvent());
  }
}

class RejectedProgressPiSession extends TestPiSession {
  async prompt(): Promise<void> {
    this.emit(agentStartEvent());
    await delay(10);
    const rejectedText = Array.from({ length: 5 }, () => `初步结论是${"这".repeat(40)}`).join("");
    this.emit(textDeltaEvent(rejectedText));
    this.emit(agentEndEvent());
  }
}

class ThrowPiSession extends TestPiSession {
  async prompt(): Promise<void> {
    this.emit(agentStartEvent());
    await delay(5);
    throw new Error("LLM provider returned 503");
  }
}

class DelayPiSession extends TestPiSession {
  private resolvePrompt: (() => void) | undefined;
  abortCalled = false;

  async prompt(text: string): Promise<void> {
    this.emit(agentStartEvent());
    return new Promise<void>((resolve) => {
      this.resolvePrompt = resolve;
    });
  }

  override async abort(): Promise<void> {
    this.abortCalled = true;
    this.resolvePrompt?.();
    this.resolvePrompt = undefined;
  }
}

class SlowToolPiSession extends TestPiSession {
  readonly promptedTexts: string[] = [];

  async prompt(text: string): Promise<void> {
    this.promptedTexts.push(text);
    this.emit(agentStartEvent());
    this.emit(toolStartEvent("web_search"));
    await delay(80);
    this.emit(toolEndEvent("web_search"));
    this.emit(textDeltaEvent("我找到了结果。"));
    this.emit(agentEndEvent());
  }
}

function makeProvider(session: TestPiSession): PiSessionProvider {
  return async (): Promise<PiSession> => session;
}

function makeMockServer(captured: RealtimeEvent[]): RuntimeWebSocketServer {
  return { broadcast: (e: RealtimeEvent) => captured.push(e) } as unknown as RuntimeWebSocketServer;
}

interface Harness {
  readonly db: DatabaseClient;
  readonly taskNest: TaskNest;
  readonly executor: TaskExecutor;
  readonly captured: RealtimeEvent[];
  readonly session: TestPiSession;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "task-executor-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function makeHarness(
  session: TestPiSession,
  ackGraceMs = 50,
  fillerStartMs = 5_000,
  fillerIntervalMs = 10_000,
): Promise<Harness> {
  const db = await DatabaseClient.open(join(tempDir, `test-${randomUUID()}.sqlite3`));
  const registry = new RoleManifestRegistry();
  registry.register(GENERAL_ROLE_MANIFEST);
  registry.register(WEB_ROLE_MANIFEST);
  const sessionManager = new PiRoleSessionManager({
    registry,
    provider: makeProvider(session),
    flushIntervalMs: 2,
  });
  const taskNest = new TaskNest({ db });
  const reflexRouter = new ReflexRouter();
  const trafficCommander = new TrafficCommander({ ackGraceMs });
  const voiceHerald = new VoiceHerald();
  const captured: RealtimeEvent[] = [];
  const executor = new TaskExecutor({
    taskNest,
    reflexRouter,
    sessionManager,
    voiceHerald,
    trafficCommander,
    server: makeMockServer(captured),
    roleRegistry: registry,
    ackGraceMs,
    fillerStartMs,
    fillerIntervalMs,
  });
  return { db, taskNest, executor, captured, session };
}

function speechTexts(captured: RealtimeEvent[]): string[] {
  return captured
    .filter((e) => e.type === "voice.speech.enqueue")
    .map((e) => e.payload["text"] as string);
}

function eventsOfType(captured: RealtimeEvent[], type: string): RealtimeEvent[] {
  return captured.filter((e) => e.type === type);
}

function taskIdFromTerminal(captured: RealtimeEvent[]): string | undefined {
  for (const type of ["task.completed", "task.failed", "task.cancelled"]) {
    const event = eventsOfType(captured, type)[0];
    if (event?.task_id) return event.task_id;
  }
  return undefined;
}

describe("Scenario: basic voice loop", () => {
  it("drives pending -> assigned -> running -> completed and produces a final speech directive", async () => {
    const echo = new EchoPiSession();
    const { db, taskNest, executor, captured } = await makeHarness(echo);

    await executor.onVoiceTranscript("你好", "conv-1", "evt-1");
    await delay(150); // fire-and-forget: wait for runTask to complete

    const taskId = taskIdFromTerminal(captured);
    expect(taskId).toBeDefined();
    const task = taskNest.get(taskId!);
    expect(task?.status).toBe("completed");
    expect(task?.roleId).toBe("general");
    expect(echo.promptedTexts).toEqual(["你好"]);

    expect(eventsOfType(captured, "task.created")[0]?.payload["goal"]).toBe("你好");
    expect(eventsOfType(captured, "task.assigned")[0]?.payload["role_id"]).toBe("general");

    const texts = speechTexts(captured);
    expect(texts).toContain("你好，我是JARVIS语音助手。");

    const completed = eventsOfType(captured, "task.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload["summary"]).toBe("你好，我是JARVIS语音助手。");

    await db.close();
  });

  it("does not speak generic completion after a long answer was already delivered", async () => {
    const longAnswer = new LongAnswerPiSession();
    const { db, executor, captured } = await makeHarness(longAnswer);

    await executor.onVoiceTranscript("你知道飞书吗？", "conv-long-answer", "evt-long-answer");
    await delay(150);

    const texts = speechTexts(captured);
    expect(texts.some((text) => text.includes("飞书是一款企业协作平台"))).toBe(true);
    expect(texts).not.toContain("已经完成了。");

    await db.close();
  });

  it("delivers terminal speech when all progress updates were rejected by VoiceHerald", async () => {
    const rejectedProgress = new RejectedProgressPiSession();
    const { db, executor, captured } = await makeHarness(rejectedProgress);

    await executor.onVoiceTranscript("帮我查一下明天上海的天气", "conv-rejected-progress", "evt-rejected-progress");
    await delay(150);

    expect(speechTexts(captured)).toContain("已经完成了。");

    await db.close();
  });

  it("routes a dynamic weather request to the Web role before starting its task", async () => {
    const echo = new EchoPiSession();
    const { db, taskNest, executor, captured } = await makeHarness(echo);

    await executor.onVoiceTranscript("帮我查一下明天上海的天气", "conv-weather", "evt-weather");
    await delay(150);

    const taskId = taskIdFromTerminal(captured);
    expect(taskNest.get(taskId ?? "")?.roleId).toBe("web");

    await db.close();
  });
});

describe("Scenario: LLM failure", () => {
  it("transitions to failed and produces an error speech directive", async () => {
    const throwSession = new ThrowPiSession();
    const { db, taskNest, executor, captured } = await makeHarness(throwSession);

    await executor.onVoiceTranscript("test", "conv-fail", "evt-fail");
    await delay(150);

    const taskId = taskIdFromTerminal(captured);
    expect(taskId).toBeDefined();
    expect(taskNest.get(taskId!)?.status).toBe("failed");

    expect(eventsOfType(captured, "task.failed")).toHaveLength(1);

    const texts = speechTexts(captured);
    expect(texts.some((t) => t.includes("503") || t.includes("失败"))).toBe(true);

    await db.close();
  });
});

describe("Scenario: task cancellation", () => {
  it("aborts the running task and transitions to cancelled when a stop phrase arrives", async () => {
    const delaySession = new DelayPiSession();
    const { db, taskNest, executor, captured } = await makeHarness(delaySession);

    await executor.onVoiceTranscript("test", "conv-cancel", "evt-1");
    await delay(30);

    await executor.onVoiceTranscript("停", "conv-cancel", "evt-2");
    await delay(30);

    expect(delaySession.abortCalled).toBe(true);

    const taskId = taskIdFromTerminal(captured);
    expect(taskId).toBeDefined();
    expect(taskNest.get(taskId!)?.status).toBe("cancelled");

    expect(eventsOfType(captured, "task.cancelled")).toHaveLength(1);

    await db.close();
  });
});

describe("TrafficCommander ack timing", () => {
  it("fires a receipt ack when the agent does not respond within ackGraceMs", async () => {
    const slowSession = new DelayPiSession();
    const { db, executor, captured } = await makeHarness(slowSession, 30);

    await executor.onVoiceTranscript("slow task", "conv-ack", "evt-1");
    await delay(80);

    expect(speechTexts(captured).some((t) => t.includes("看看"))).toBe(true);

    await executor.onVoiceTranscript("停", "conv-ack", "evt-2").catch(() => undefined);
    await delay(30);
    await db.close();
  });
});

describe("Three-level acknowledgement flow", () => {
  it("speaks the tool action immediately and suppresses the delayed generic receipt", async () => {
    const slowTool = new SlowToolPiSession();
    const { db, executor, captured } = await makeHarness(slowTool, 30, 5_000, 10_000);

    await executor.onVoiceTranscript("帮我查一下天气", "conv-tool-ack", "evt-tool-ack");
    await delay(100);

    const texts = speechTexts(captured);
    expect(texts.some((text) => /查|搜/.test(text))).toBe(true);
    expect(texts).not.toContain("好的，我在处理。");

    await delay(100);
    await db.close();
  });

  it("speaks a cancellable filler only while a tool remains idle", async () => {
    const slowTool = new SlowToolPiSession();
    const { db, executor, captured } = await makeHarness(slowTool, 200, 20, 20);

    await executor.onVoiceTranscript("帮我查一下天气", "conv-filler", "evt-filler");
    await delay(45);

    const fillerCount = speechTexts(captured).filter((text) => text.includes("还在") || text.includes("确认")).length;
    expect(fillerCount).toBeGreaterThan(0);

    await delay(80);
    const countAfterCompletion = speechTexts(captured).filter((text) => text.includes("还在") || text.includes("确认")).length;
    await delay(80);
    expect(speechTexts(captured).filter((text) => text.includes("还在") || text.includes("确认"))).toHaveLength(countAfterCompletion);

    await db.close();
  });
});
