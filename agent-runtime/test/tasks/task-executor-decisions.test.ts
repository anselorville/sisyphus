/**
 * The TaskExecutor consumes the decision layer: which role a spoken request
 * goes to, what happens to an answer while a mail action is waiting for a yes.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DecisionEngine } from "../../src/decision/decision-engine.js";
import { JevClient, type JevTransport } from "../../src/decision/jev-client.js";
import { TurnDecider } from "../../src/decision/turn-decision.js";
import type { RealtimeEvent } from "../../src/protocol/events.js";
import { RoleManifestRegistry } from "../../src/roles/registry.js";
import { GENERAL_ROLE_MANIFEST, MAIL_ROLE_MANIFEST, WEB_ROLE_MANIFEST } from "../../src/roles/manifests.js";
import { PiRoleSessionManager } from "../../src/roles/session-manager.js";
import type { PiSession, PiSessionProvider } from "../../src/roles/types.js";
import { ReflexRouter } from "../../src/routing/reflex-router.js";
import { DatabaseClient } from "../../src/storage/database.js";
import { MailConfirmationGate } from "../../src/tools/mail/mail-confirmation.js";
import { TaskExecutor } from "../../src/tasks/task-executor.js";
import { TaskNest } from "../../src/tasks/task-nest.js";
import { TrafficCommander } from "../../src/voice/traffic-commander.js";
import { AckGenerator } from "../../src/voice/ack-generator.js";
import { VoiceHerald } from "../../src/voice/voice-herald.js";
import type { RuntimeWebSocketServer } from "../../src/transport/websocket-server.js";

class QuietSession implements PiSession {
  readonly messages: readonly unknown[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt(): Promise<void> {
    for (const l of this.listeners) l({ type: "agent_start" } as unknown as AgentSessionEvent);
    for (const l of this.listeners) l({ type: "agent_end", willRetry: false } as unknown as AgentSessionEvent);
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  dispose(): void {}
}

/** A Jev whose answers are scripted per utterance. */
class ScriptedJev implements JevTransport {
  asked: string[] = [];
  constructor(private readonly reply: (utterance: string) => object) {}
  async request(_m: "GET" | "POST", path: string, body?: string) {
    if (path === "/v1/models") return { status: 200, body: "{}" };
    const utterance = JSON.parse(body ?? "{}").state.user_utterance as string;
    this.asked.push(utterance);
    return { status: 200, body: JSON.stringify(this.reply(utterance)) };
  }
  close(): void {}
}

const choice = (probs: Record<string, number>) => {
  const [name, p] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice: name, confidence: p, probabilities: probs };
};

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "executor-decisions-"));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function harness(jev: ScriptedJev | undefined, mode: "off" | "live") {
  const db = await DatabaseClient.open(join(tempDir, `${randomUUID()}.sqlite3`));
  const registry = new RoleManifestRegistry();
  for (const m of [GENERAL_ROLE_MANIFEST, WEB_ROLE_MANIFEST, MAIL_ROLE_MANIFEST]) registry.register(m);
  const provider: PiSessionProvider = async () => new QuietSession();
  const sessionManager = new PiRoleSessionManager({ registry, provider, flushIntervalMs: 2 });
  const captured: RealtimeEvent[] = [];
  const server = { broadcast: (e: RealtimeEvent) => captured.push(e) } as unknown as RuntimeWebSocketServer;
  const gate = new MailConfirmationGate();
  const client = new JevClient({ transport: jev, onWarn: () => {}, keepAliveIntervalMs: 3_600_000 });
  client.start();
  await client.whenWarm();
  const reflexRouter = new ReflexRouter();
  const executor = new TaskExecutor({
    taskNest: new TaskNest({ db }),
    reflexRouter,
    sessionManager,
    voiceHerald: new VoiceHerald(),
    trafficCommander: new TrafficCommander({ ackGraceMs: 50 }),
    server,
    roleRegistry: registry,
    ackGraceMs: 50,
    confirmation: gate,
    turnDecider: new TurnDecider({ engine: new DecisionEngine({ client, mode }), reflex: reflexRouter }),
  });
  const assignedRoles = () => captured.filter((e) => e.type === "task.assigned").map((e) => e.payload["role_id"]);
  return { db, executor, gate, assignedRoles, client };
}

const NEW_REQUEST = (role: string) => ({
  answers: { intent: choice({ new_request: 0.99, stop_speaking: 0.01 }), role: choice({ [role]: 0.97, general: 0.03 }) },
});

describe("TaskExecutor + decision layer", () => {
  it("sends a request no keyword matches to the specialist Jev picks", async () => {
    const jev = new ScriptedJev(() => NEW_REQUEST("mail"));
    const { executor, assignedRoles, db, client } = await harness(jev, "live");

    await executor.onVoiceTranscript("有没有人给我回信", "conv-1");

    expect(assignedRoles()).toEqual(["mail"]);
    client.stop();
    await db.close();
  });

  it("falls back to the rule when Jev is off, and the same request goes to the general worker", async () => {
    const { executor, assignedRoles, db, client } = await harness(new ScriptedJev(() => NEW_REQUEST("mail")), "off");

    await executor.onVoiceTranscript("有没有人给我回信", "conv-2");

    expect(assignedRoles()).toEqual(["general"]);
    client.stop();
    await db.close();
  });

  it("records the user's yes while a mail action is pending, and routes it back to the mail role", async () => {
    const jev = new ScriptedJev((utterance) =>
      utterance === "好，发吧"
        ? { answers: { ...NEW_REQUEST("general").answers, pending_answer: choice({ confirm: 0.98, decline: 0.01, unrelated: 0.005, unclear: 0.005 }) } }
        : NEW_REQUEST("general"),
    );
    const { executor, gate, assignedRoles, db, client } = await harness(jev, "live");
    const pending = gate.prepare("send:a", "send 'hi' to a@b.com", "mail");
    expect(gate.consume(pending.id, "send:a").ok).toBe(false); // not yet answered

    await executor.onVoiceTranscript("好，发吧", "conv-3");

    expect(assignedRoles()).toEqual(["mail"]);
    expect(gate.consume(pending.id, "send:a")).toEqual({ ok: true });
    client.stop();
    await db.close();
  });

  it("does not unlock the action for an unrelated utterance, and does not misroute it to mail", async () => {
    const jev = new ScriptedJev(() => ({
      answers: { ...NEW_REQUEST("web").answers, pending_answer: choice({ confirm: 0.01, decline: 0.01, unrelated: 0.97, unclear: 0.01 }) },
    }));
    const { executor, gate, assignedRoles, db, client } = await harness(jev, "live");
    const pending = gate.prepare("send:a", "send 'hi' to a@b.com", "mail");

    await executor.onVoiceTranscript("今天上海天气怎么样", "conv-4");

    expect(assignedRoles()).toEqual(["web"]);
    expect(gate.consume(pending.id, "send:a").ok).toBe(false);
    expect(gate.pendingQuestion()).toBeDefined();
    client.stop();
    await db.close();
  });

  it("with no Jev at all, an unmistakable yes still confirms and a vague 'looks like rain' does not", async () => {
    const { executor, gate, db, client } = await harness(undefined, "off");
    const pending = gate.prepare("send:a", "send 'hi' to a@b.com", "mail");

    await executor.onVoiceTranscript("好像要下雨了", "conv-5");
    expect(gate.consume(pending.id, "send:a").ok).toBe(false);

    await executor.onVoiceTranscript("好，发吧", "conv-5");
    expect(gate.consume(pending.id, "send:a")).toEqual({ ok: true });
    client.stop();
    await db.close();
  });
});

/** Answers after `ms` with one sentence, saying nothing before that. */
class SlowAnswerSession extends QuietSession {
  prompts: string[] = [];
  constructor(private readonly ms: number) {
    super();
  }
  override async prompt(text?: unknown): Promise<void> {
    this.prompts.push(String(text));
    const emit = (e: object) => (this as unknown as { listeners: Set<(e: AgentSessionEvent) => void> }).listeners.forEach((l) => l(e as AgentSessionEvent));
    emit({ type: "agent_start" });
    await new Promise((r) => setTimeout(r, this.ms));
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "我是 Marcus。" } });
    emit({ type: "agent_end", willRetry: false });
  }
}

async function ackHarness(session: SlowAnswerSession) {
  const db = await DatabaseClient.open(join(tempDir, `${randomUUID()}.sqlite3`));
  const registry = new RoleManifestRegistry();
  for (const m of [GENERAL_ROLE_MANIFEST, WEB_ROLE_MANIFEST, MAIL_ROLE_MANIFEST]) registry.register(m);
  const sessionManager = new PiRoleSessionManager({ registry, provider: async () => session, flushIntervalMs: 2 });
  const captured: RealtimeEvent[] = [];
  const logged: RealtimeEvent[] = [];
  const server = { broadcast: (e: RealtimeEvent) => captured.push(e) } as unknown as RuntimeWebSocketServer;
  const client = new JevClient({ onWarn: () => {} });
  const reflexRouter = new ReflexRouter();
  const executor = new TaskExecutor({
    taskNest: new TaskNest({ db }),
    reflexRouter,
    sessionManager,
    voiceHerald: new VoiceHerald(),
    trafficCommander: new TrafficCommander({ ackGraceMs: 30, ackGenerator: new AckGenerator() }),
    server,
    roleRegistry: registry,
    ackGraceMs: 30,
    immediateAckSafetyMs: 150,
    eventLog: (e) => logged.push(e),
    turnDecider: new TurnDecider({ engine: new DecisionEngine({ client, mode: "off" }), reflex: reflexRouter, ackMode: "shadow" }),
  });
  const receipts = () => captured.filter((e) => e.type === "voice.speech.enqueue" && e.payload["kind"] === "receipt").map((e) => e.payload["text"] as string);
  return { db, executor, captured, logged, receipts };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await wait(10);
}

describe("TaskExecutor + ack gate", () => {
  it("says no 'let me check' before answering a greeting", async () => {
    const { db, executor, receipts, logged } = await ackHarness(new SlowAnswerSession(80));

    await executor.onVoiceTranscript("请用一句话介绍你自己。", "conv-a1");
    await wait(140);

    expect(receipts()).toEqual([]);
    expect(logged.find((e) => e.type === "turn.trace")?.payload).toMatchObject({ ack: "immediate" });
    await db.close();
  });

  it("still breaks a long silence on a greeting with a neutral ack", async () => {
    const { db, executor, receipts } = await ackHarness(new SlowAnswerSession(260));

    await executor.onVoiceTranscript("你好", "conv-a2");
    await wait(320);

    expect(receipts()).toEqual(["嗯，稍等。"]);
    await db.close();
  });

  it("words the ack for a lookup as a lookup", async () => {
    const { db, executor, receipts } = await ackHarness(new SlowAnswerSession(80));

    await executor.onVoiceTranscript("帮我查一下明天上海的天气", "conv-a3");
    await wait(140);

    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]).toMatch(/查|搜/);
    await db.close();
  });

  it("a turn queued behind a running task goes through the decision path when it starts", async () => {
    const session = new SlowAnswerSession(60);
    const { db, executor, captured, logged } = await ackHarness(session);

    await executor.onVoiceTranscript("帮我查一下明天上海的天气", "conv-q");
    await executor.onVoiceTranscript("再介绍一下你自己", "conv-q");
    await until(() => logged.filter((e) => e.type === "turn.trace").length >= 2);

    // Both turns were announced as tasks (the queued one used to skip task.created).
    expect(captured.filter((e) => e.type === "task.created").map((e) => e.payload["goal"])).toEqual([
      "帮我查一下明天上海的天气",
      "再介绍一下你自己",
    ]);
    const traces = logged.filter((e) => e.type === "turn.trace").map((e) => e.payload as { marks: Record<string, number>; ack: string });
    expect(traces).toHaveLength(2);
    expect(typeof traces[1]!.marks["queued"]).toBe("number");
    expect(traces[1]!.marks["task_started"]!).toBeGreaterThan(traces[1]!.marks["queued"]!);
    expect(traces[1]!.ack).toBe("immediate");
    await db.close();
  });
});
