import { describe, expect, it } from "vitest";
import { reduceAgentTasks, type AgentTasksState, type AgentTaskWireEvent } from "./useAgentTasks";

const EMPTY: AgentTasksState = { tasks: [] };

function apply(state: AgentTasksState, ...events: AgentTaskWireEvent[]): AgentTasksState {
  return events.reduce(reduceAgentTasks, state);
}

describe("reduceAgentTasks", () => {
  it("creates a pending task from task.created", () => {
    const next = reduceAgentTasks(EMPTY, { type: "task.created", task_id: "t1", goal: "Book a flight" });
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]).toMatchObject({ id: "t1", goal: "Book a flight", status: "pending" });
  });

  it("does not create a duplicate task when task.created is delivered twice", () => {
    const state = apply(
      EMPTY,
      { type: "task.created", task_id: "t1", goal: "Book a flight" },
      { type: "task.created", task_id: "t1", goal: "Book a flight" },
    );
    expect(state.tasks).toHaveLength(1);
  });

  it("does not duplicate a task when an already-applied event replays (e.g. redelivery after reconnect)", () => {
    const state = apply(
      EMPTY,
      { type: "task.created", task_id: "t1", goal: "Book a flight" },
      { type: "task.assigned", task_id: "t1", role_id: "role-a" },
      { type: "task.assigned", task_id: "t1", role_id: "role-a" },
    );
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].status).toBe("assigned");
  });

  it("moves a task through its lifecycle to completed, carrying the summary as detail", () => {
    const state = apply(
      EMPTY,
      { type: "task.created", task_id: "t1", goal: "Book a flight" },
      { type: "task.assigned", task_id: "t1", role_id: "role-a" },
      { type: "task.progress", task_id: "t1", text: "Searching flights" },
      { type: "task.completed", task_id: "t1", summary: "Booked flight AA123" },
    );
    expect(state.tasks[0]).toMatchObject({ status: "completed", detail: "Booked flight AA123" });
  });

  it("a task that reached completed does not revert to running on a stale/late progress event", () => {
    const state = apply(
      EMPTY,
      { type: "task.created", task_id: "t1", goal: "Book a flight" },
      { type: "task.completed", task_id: "t1", summary: "Booked flight AA123" },
      { type: "task.progress", task_id: "t1", text: "still searching..." },
    );
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].status).toBe("completed");
    expect(state.tasks[0].detail).toBe("Booked flight AA123");
  });

  it("a cancelled task does not revert on a stale task.assigned event", () => {
    const state = apply(
      EMPTY,
      { type: "task.created", task_id: "t1", goal: "Book a flight" },
      { type: "task.cancelled", task_id: "t1" },
      { type: "task.assigned", task_id: "t1", role_id: "late-role" },
    );
    expect(state.tasks[0].status).toBe("cancelled");
  });

  it("ignores wire events that are not task-lifecycle events", () => {
    const next = reduceAgentTasks(EMPTY, { type: "ecology.state.changed", state: "prosperous" } as unknown as AgentTaskWireEvent);
    expect(next).toBe(EMPTY);
  });

  it("keeps two different tasks independent", () => {
    const state = apply(
      EMPTY,
      { type: "task.created", task_id: "t1", goal: "A" },
      { type: "task.created", task_id: "t2", goal: "B" },
      { type: "task.completed", task_id: "t1", summary: "done A" },
    );
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks.find((task) => task.id === "t1")?.status).toBe("completed");
    expect(state.tasks.find((task) => task.id === "t2")?.status).toBe("pending");
  });

  it("synthesizes a task from an out-of-order event for an unknown task_id rather than dropping it", () => {
    const state = reduceAgentTasks(EMPTY, { type: "task.progress", task_id: "t9", text: "already working" });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({ id: "t9", status: "running", detail: "already working" });
  });

  it("keeps Scribe phrase and summary as separate topic fields", () => {
    const state = reduceAgentTasks(EMPTY, {
      type: "session.topics.updated",
      topics: [{ id: "feishu", phrase: "飞书", summary: "企业协作平台", status: "active" }],
    });

    expect(state.tasks[0]).toMatchObject({
      id: "feishu",
      goal: "飞书",
      topicPhrase: "飞书",
      topicSummary: "企业协作平台",
      status: "pending",
    });
  });

  it("uses available event text instead of an Untitled task fallback", () => {
    const state = reduceAgentTasks(EMPTY, { type: "task.progress", task_id: "t9", text: "正在整理飞书话题" });

    expect(state.tasks[0]?.goal).toBe("正在整理飞书话题");
    expect(state.tasks[0]?.goal).not.toBe("Untitled task");
  });

  it("preserves the previous ledger when a topic payload contains an invalid item", () => {
    const previous = reduceAgentTasks(EMPTY, {
      type: "session.topics.updated",
      topics: [{ id: "feishu", phrase: "飞书", summary: "企业协作平台", status: "active" }],
    });

    const next = reduceAgentTasks(previous, {
      type: "session.topics.updated",
      topics: [{ id: "weather", phrase: "天气", summary: "", status: "active" }],
    });

    expect(next).toBe(previous);
  });

  it("rejects placeholder topic phrases and unknown topic statuses", () => {
    const previous = reduceAgentTasks(EMPTY, {
      type: "session.topics.updated",
      topics: [{ id: "feishu", phrase: "飞书", summary: "企业协作平台", status: "active" }],
    });

    const placeholder = reduceAgentTasks(previous, {
      type: "session.topics.updated",
      topics: [{ id: "unknown", phrase: "Untitled task", summary: "无标题", status: "active" }],
    });
    const unknownStatus = reduceAgentTasks(previous, {
      type: "session.topics.updated",
      topics: [{ id: "weather", phrase: "天气", summary: "天气信息", status: "pending" }],
    });

    expect(placeholder).toBe(previous);
    expect(unknownStatus).toBe(previous);
  });

  it("clears the ledger when the server sends an authoritative empty topic list", () => {
    const previous = reduceAgentTasks(EMPTY, {
      type: "session.topics.updated",
      topics: [{ id: "feishu", phrase: "飞书", summary: "企业协作平台", status: "active" }],
    });

    const next = reduceAgentTasks(previous, { type: "session.topics.updated", topics: [] });

    expect(next.tasks).toEqual([]);
  });

  it("rejects duplicate topic IDs atomically", () => {
    const previous = reduceAgentTasks(EMPTY, {
      type: "session.topics.updated",
      topics: [{ id: "feishu", phrase: "飞书", summary: "企业协作平台", status: "active" }],
    });

    const next = reduceAgentTasks(previous, {
      type: "session.topics.updated",
      topics: [
        { id: "weather", phrase: "天气", summary: "天气信息", status: "active" },
        { id: "weather", phrase: "空气质量", summary: "空气信息", status: "closed" },
      ],
    });

    expect(next).toBe(previous);
  });

  it("rejects topic snapshots with more than one active topic", () => {
    const previous = reduceAgentTasks(EMPTY, {
      type: "session.topics.updated",
      topics: [{ id: "feishu", phrase: "飞书", summary: "企业协作平台", status: "active" }],
    });

    const next = reduceAgentTasks(previous, {
      type: "session.topics.updated",
      topics: [
        { id: "weather", phrase: "天气", summary: "天气信息", status: "active" },
        { id: "air", phrase: "空气质量", summary: "空气信息", status: "active" },
      ],
    });

    expect(next).toBe(previous);
  });
});
