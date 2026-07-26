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
});
