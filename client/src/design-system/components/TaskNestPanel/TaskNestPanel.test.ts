import { describe, expect, it } from "vitest";
import type { AgentTask } from "../../../hooks/useAgentTasks";
import { getPreferredWindowStart, getVisibleTaskIndexes, shouldPauseRotation } from "./TaskNestPanel";

function task(id: string, status: AgentTask["status"]): AgentTask {
  return { id, goal: id, status, updatedAt: 0 };
}

describe("getPreferredWindowStart", () => {
  it("keeps the active topic inside the initial two-card window", () => {
    const tasks = [task("closed-1", "completed"), task("closed-2", "completed"), task("active", "pending"), task("queued", "pending")];

    expect(getPreferredWindowStart(tasks, 0)).toBe(1);
  });

  it("clamps a requested window to the available topic range", () => {
    const tasks = [task("one", "completed"), task("two", "completed"), task("three", "completed")];

    expect(getPreferredWindowStart(tasks, 99)).toBe(1);
  });
});

describe("getVisibleTaskIndexes", () => {
  it("pins the active topic while rotating its companion slot", () => {
    const tasks = [task("active", "pending"), task("closed-1", "completed"), task("closed-2", "completed")];

    expect(getVisibleTaskIndexes(tasks, 0)).toEqual([0, 1]);
    expect(getVisibleTaskIndexes(tasks, 1)).toEqual([0, 2]);
  });
});

describe("shouldPauseRotation", () => {
  it("keeps rotation paused while any interaction or explicit pause remains active", () => {
    expect(shouldPauseRotation({ hovered: true, focused: false, explicitlyPaused: false })).toBe(true);
    expect(shouldPauseRotation({ hovered: false, focused: true, explicitlyPaused: false })).toBe(true);
    expect(shouldPauseRotation({ hovered: false, focused: false, explicitlyPaused: true })).toBe(true);
  });

  it("resumes only after hover, focus, and explicit pause are all inactive", () => {
    expect(shouldPauseRotation({ hovered: false, focused: false, explicitlyPaused: false })).toBe(false);
  });
});
