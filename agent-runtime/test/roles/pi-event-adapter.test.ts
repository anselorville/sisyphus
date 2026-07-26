import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { PiEventAdapter } from "../../src/roles/pi-event-adapter.js";

/**
 * Fixture builders for the real `AgentSessionEvent` union (verified against
 * node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts
 * and node_modules/@earendil-works/pi-agent-core/dist/types.d.ts). Only the
 * fields PiEventAdapter actually reads are populated -- these are test
 * doubles, not full reconstructions of the SDK's internal message shapes,
 * so they lean on `as unknown as AgentSessionEvent` rather than building a
 * fully valid AgentMessage/AssistantMessage tree.
 */
const FAKE_MESSAGE = { role: "assistant", content: [] };

function textDelta(delta: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: FAKE_MESSAGE,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: FAKE_MESSAGE },
  } as unknown as AgentSessionEvent;
}

function thinkingDelta(delta: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: FAKE_MESSAGE,
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: FAKE_MESSAGE },
  } as unknown as AgentSessionEvent;
}

function agentStart(): AgentSessionEvent {
  return { type: "agent_start" } as unknown as AgentSessionEvent;
}

function turnStart(): AgentSessionEvent {
  return { type: "turn_start" } as unknown as AgentSessionEvent;
}

function turnEnd(): AgentSessionEvent {
  return { type: "turn_end", message: FAKE_MESSAGE, toolResults: [] } as unknown as AgentSessionEvent;
}

function agentEnd(willRetry: boolean): AgentSessionEvent {
  return { type: "agent_end", messages: [], willRetry } as unknown as AgentSessionEvent;
}

function toolStart(
  overrides: Partial<{ toolCallId: string; toolName: string; args: unknown }> = {},
): AgentSessionEvent {
  return {
    type: "tool_execution_start",
    toolCallId: overrides.toolCallId ?? "call-1",
    toolName: overrides.toolName ?? "read",
    args: overrides.args ?? { path: "a.txt" },
  } as unknown as AgentSessionEvent;
}

function toolEnd(
  overrides: Partial<{ toolCallId: string; toolName: string; result: unknown; isError: boolean }> = {},
): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId: overrides.toolCallId ?? "call-1",
    toolName: overrides.toolName ?? "read",
    result: overrides.result ?? "ok",
    isError: overrides.isError ?? false,
  } as unknown as AgentSessionEvent;
}

function queueUpdate(steering: string[], followUp: string[]): AgentSessionEvent {
  return { type: "queue_update", steering, followUp } as unknown as AgentSessionEvent;
}

describe("PiEventAdapter construction", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-positive/non-finite flushIntervalMs (%s)",
    (value) => {
      expect(() => new PiEventAdapter({ flushIntervalMs: value })).toThrow(RangeError);
    },
  );
});

describe("message_update aggregation", () => {
  it("aggregates text deltas instead of broadcasting each token", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    adapter.accept(textDelta("你"));
    adapter.accept(textDelta("好"));
    expect(adapter.flush()).toMatchObject({
      type: "task.progress",
      payload: { text: "你好" },
    });
  });

  it("never hands a delta back from accept() -- flush() is the only broadcast path", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.accept(textDelta("h"))).toBeUndefined();
  });

  it("returns undefined from flush() when nothing is pending", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.flush()).toBeUndefined();
  });

  it("clears the buffer after flush(), so a second flush without new deltas is undefined", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    adapter.accept(textDelta("hi"));
    expect(adapter.flush()).toMatchObject({ payload: { text: "hi" } });
    expect(adapter.flush()).toBeUndefined();
  });

  it("ignores non-text-delta message_update sub-events (e.g. thinking deltas)", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    adapter.accept(thinkingDelta("pondering..."));
    expect(adapter.flush()).toBeUndefined();
  });
});

describe("discrete event mapping", () => {
  it("maps agent_start to task.assigned", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.accept(agentStart())).toEqual({ type: "task.assigned", payload: {} });
  });

  it("maps tool_execution_start to tool.started", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.accept(toolStart({ toolCallId: "c1", toolName: "bash", args: { command: "ls" } }))).toEqual({
      type: "tool.started",
      payload: { tool_call_id: "c1", tool_name: "bash", args: { command: "ls" } },
    });
  });

  it("maps a successful tool_execution_end to tool.completed", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.accept(toolEnd({ isError: false, result: "42 files" }))).toEqual({
      type: "tool.completed",
      payload: { tool_call_id: "call-1", tool_name: "read", result: "42 files" },
    });
  });

  it("maps a failed tool_execution_end to tool.failed", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.accept(toolEnd({ isError: true, result: "boom" }))).toMatchObject({
      type: "tool.failed",
      payload: { result: "boom" },
    });
  });

  it("maps turn_end to a task.progress marker", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.accept(turnEnd())).toEqual({ type: "task.progress", payload: { turn_ended: true } });
  });

  it("maps agent_end to task.completed, carrying willRetry through", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.accept(agentEnd(true))).toEqual({ type: "task.completed", payload: { will_retry: true } });
  });

  it("maps queue_update to a task.progress snapshot of steering/followUp", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.accept(queueUpdate(["do x"], []))).toEqual({
      type: "task.progress",
      payload: { steering: ["do x"], follow_up: [] },
    });
  });

  it("ignores event kinds it does not map (e.g. turn_start)", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    expect(adapter.accept(turnStart())).toBeUndefined();
  });
});

describe("interleaving", () => {
  it("keeps buffered text pending across a discrete event mapped in between", () => {
    const adapter = new PiEventAdapter({ flushIntervalMs: 50 });
    adapter.accept(textDelta("partial answer"));

    expect(adapter.accept(toolStart())).toMatchObject({ type: "tool.started" });
    expect(adapter.flush()).toMatchObject({ payload: { text: "partial answer" } });
  });
});
