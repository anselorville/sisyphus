import { describe, expect, it } from "vitest";

import type { RealtimeEvent, RealtimeEventType } from "../../src/protocol/events.js";
import { VoiceHerald } from "../../src/voice/voice-herald.js";

let counter = 0;

function makeEvent(overrides: Partial<RealtimeEvent> & Pick<RealtimeEvent, "type">): RealtimeEvent {
  counter += 1;
  return {
    event_id: `evt-${counter}`,
    sequence: counter,
    source: "swarm",
    timestamp: new Date(0).toISOString(),
    task_id: "task-1",
    payload: {},
    ...overrides,
  };
}

function eventOfType(type: RealtimeEventType, payload: Record<string, unknown> = {}): RealtimeEvent {
  return makeEvent({ type, payload });
}

function toolProgress(payload: Record<string, unknown>): RealtimeEvent {
  return makeEvent({
    type: "tool.completed",
    payload: { tool_call_id: "tc-1", tool_name: "bash", ...payload },
  });
}

function elevationRequest(payload: Record<string, unknown> = {}): RealtimeEvent {
  return eventOfType("diplomacy.elevation.requested", {
    action: "删除 30 个失败任务的日志文件",
    impact: "过去 7 天的失败日志将无法恢复",
    ...payload,
  });
}

function taskCreated(): RealtimeEvent {
  return eventOfType("task.created", { goal: "run the test suite" });
}

function taskAssigned(): RealtimeEvent {
  return eventOfType("task.assigned", {});
}

function taskCancelled(): RealtimeEvent {
  return eventOfType("task.cancelled", {});
}

function progressEvent(text: unknown): RealtimeEvent {
  return eventOfType("task.progress", { text });
}

function completedEvent(summary?: unknown): RealtimeEvent {
  return eventOfType("task.completed", summary === undefined ? {} : { summary });
}

function failedEvent(reason?: unknown): RealtimeEvent {
  return eventOfType("task.failed", reason === undefined ? {} : { reason });
}

function budgetEvent(state?: unknown): RealtimeEvent {
  return eventOfType("budget.updated", state === undefined ? {} : { state });
}

function ecologyEvent(state?: unknown): RealtimeEvent {
  return eventOfType("ecology.state.changed", state === undefined ? {} : { state });
}

describe("VoiceHerald.accept -- forbidden content (Step 2 mandated tests)", () => {
  const herald = new VoiceHerald();

  it("never speaks tool logs or code blocks", () => {
    expect(herald.accept(toolProgress({ output: "```python\nprint(1)\n```" }))).toBeNull();
  });

  it("speaks a concise elevation request", () => {
    expect(herald.accept(elevationRequest())).toMatchObject({
      kind: "elevation",
      text: expect.stringMatching(/准备.*影响.*允许/),
    });
  });
});

describe("VoiceHerald.accept -- allowed categories", () => {
  const herald = new VoiceHerald();

  it("allows a receipt acknowledgement for a newly created task", () => {
    expect(herald.accept(taskCreated())).toMatchObject({ kind: "receipt" });
  });

  it("allows a receipt acknowledgement when a role is assigned", () => {
    expect(herald.accept(taskAssigned())).toMatchObject({ kind: "receipt" });
  });

  it("allows a short acknowledgement when a task is cancelled", () => {
    expect(herald.accept(taskCancelled())).toMatchObject({ kind: "receipt" });
  });

  it("allows real progress with an actual state change to report", () => {
    const directive = herald.accept(progressEvent("测试都通过了，正在生成报告"));
    expect(directive).toMatchObject({ kind: "progress", text: "测试都通过了，正在生成报告" });
  });

  it("allows a final result summary", () => {
    const directive = herald.accept(completedEvent("全部测试通过，一共跑了 42 个用例"));
    expect(directive).toMatchObject({ kind: "final", text: "全部测试通过，一共跑了 42 个用例" });
  });

  it("still speaks a generic final directive when no summary text is supplied (never fabricates one)", () => {
    expect(herald.accept(completedEvent())).toMatchObject({ kind: "final" });
  });

  it("allows an error status when a task fails", () => {
    const directive = herald.accept(failedEvent("邮件服务暂时不可用"));
    expect(directive).toMatchObject({ kind: "error", text: "邮件服务暂时不可用" });
  });

  it("allows budget status", () => {
    expect(herald.accept(budgetEvent("reserve"))).toMatchObject({ kind: "budget" });
    expect(herald.accept(budgetEvent("prosperous"))).toMatchObject({ kind: "budget" });
  });

  it("allows hibernation status", () => {
    const directive = herald.accept(ecologyEvent("hibernating"));
    expect(directive).toMatchObject({ kind: "hibernation" });
    expect(directive?.text.length).toBeGreaterThan(0);
  });

  it("allows an elevation-resolved confirmation", () => {
    expect(herald.accept(eventOfType("diplomacy.elevation.resolved", { approved: true }))).toMatchObject({
      kind: "elevation",
    });
  });

  it("carries the originating task_id through", () => {
    const event = makeEvent({ type: "task.progress", task_id: "task-42", payload: { text: "还在跑测试" } });
    expect(herald.accept(event)?.taskId).toBe("task-42");
  });
});

describe("VoiceHerald.accept -- blocked content", () => {
  const herald = new VoiceHerald();

  it("blocks raw JSON masquerading as progress", () => {
    expect(herald.accept(progressEvent('{"status":"ok","code":200,"detail":"done"}'))).toBeNull();
  });

  it("blocks a long URL", () => {
    const text = "详情看这里 https://example.com/some/very/long/path/that/keeps/going/and/going/forever";
    expect(herald.accept(progressEvent(text))).toBeNull();
  });

  it("blocks a long file path", () => {
    const text = "文件在 /Users/name/projects/agent-runtime/src/routing/reflex-router.ts 里";
    expect(herald.accept(progressEvent(text))).toBeNull();
  });

  it("blocks an unverified intermediate conclusion", () => {
    expect(herald.accept(progressEvent("初步结论是数据库连接超时导致的，不过还未验证"))).toBeNull();
  });

  it("blocks a long multi-line dump", () => {
    const text = "步骤一：读取文件\n步骤二：解析内容\n步骤三：写回结果\n步骤四：清理临时文件";
    expect(herald.accept(progressEvent(text))).toBeNull();
  });

  it("blocks an over-long utterance even without any other red flag", () => {
    const text = "这".repeat(200);
    expect(herald.accept(progressEvent(text))).toBeNull();
  });

  it("blocks a non-string or empty payload text", () => {
    expect(herald.accept(progressEvent(undefined))).toBeNull();
    expect(herald.accept(progressEvent(42))).toBeNull();
    expect(herald.accept(progressEvent(""))).toBeNull();
    expect(herald.accept(progressEvent("   "))).toBeNull();
  });

  it("falls back to a generic final phrase instead of speaking a forbidden summary", () => {
    const directive = herald.accept(completedEvent('{"ok":true,"count":3}'));
    expect(directive).toMatchObject({ kind: "final" });
    expect(directive?.text).not.toContain("{");
  });

  it("falls back to a generic error phrase instead of speaking a forbidden reason", () => {
    const directive = herald.accept(failedEvent("```\nTraceback (most recent call last):\n```"));
    expect(directive).toMatchObject({ kind: "error" });
    expect(directive?.text).not.toContain("```");
  });
});

describe("VoiceHerald.accept -- categorically never spoken, regardless of content", () => {
  const herald = new VoiceHerald();

  it("never speaks tool.started events", () => {
    expect(herald.accept(eventOfType("tool.started", { tool_name: "bash", args: {} }))).toBeNull();
  });

  it("never speaks tool.failed events", () => {
    expect(herald.accept(eventOfType("tool.failed", { tool_name: "bash", result: "boom" }))).toBeNull();
  });

  it("never echoes the user's own transcript", () => {
    expect(herald.accept(eventOfType("voice.transcript.final", { text: "帮我查一下天气" }))).toBeNull();
  });

  it("never speaks the raw inbound steer/follow_up instruction event", () => {
    expect(herald.accept(eventOfType("task.steer", { text: "改成只跑单元测试" }))).toBeNull();
    expect(herald.accept(eventOfType("task.follow_up", { text: "然后发邮件" }))).toBeNull();
  });

  it("never speaks role lifecycle bookkeeping", () => {
    expect(herald.accept(eventOfType("role.hatched", { roleId: "mail" }))).toBeNull();
  });
});

describe("VoiceHerald.accept -- hard-hibernation local prompt (Task 14 addition)", () => {
  const herald = new VoiceHerald();

  it("speaks the fixed usage_exhausted local prompt without going through the content-safety gate", () => {
    const event = eventOfType("voice.speech.enqueue", { kind: "local_prompt", promptKey: "usage_exhausted" });
    const directive = herald.accept(event);
    expect(directive).toMatchObject({ kind: "hibernation" });
    expect(directive?.text.length).toBeGreaterThan(0);
  });

  it("never speaks an unrecognized local_prompt key", () => {
    const event = eventOfType("voice.speech.enqueue", { kind: "local_prompt", promptKey: "totally_unknown_key" });
    expect(herald.accept(event)).toBeNull();
  });

  it("still rejects every other voice.speech.enqueue shape", () => {
    expect(herald.accept(eventOfType("voice.speech.enqueue", { kind: "tts_direct", text: "hello" }))).toBeNull();
    expect(herald.accept(eventOfType("voice.speech.enqueue", {}))).toBeNull();
  });
});
