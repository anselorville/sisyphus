import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseClient } from "../../src/storage/database.js";
import {
  InvalidTaskTransitionError,
  TaskNest,
  TaskNestCapacityError,
  TaskNotFoundError,
} from "../../src/tasks/task-nest.js";

let tempDir: string;
const openClients: DatabaseClient[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-task-nest-test-"));
});

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((db) => db.close()));
  await rm(tempDir, { recursive: true, force: true });
});

async function openDb(path?: string): Promise<DatabaseClient> {
  const db = await DatabaseClient.open(path ?? join(tempDir, `${randomUUID()}.sqlite3`));
  openClients.push(db);
  return db;
}

describe("TaskNest state machine", () => {
  it("rejects completed -> running regression", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });

    const task = await nest.create({ goal: "run tests", interactionId: "i1" });
    await nest.transition(task.id, "completed");

    await expect(nest.transition(task.id, "running")).rejects.toThrow(/invalid transition/);
  });

  it("creates a task in pending status with the expected fields", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });

    const task = await nest.create({ goal: "book a flight", interactionId: "i1", metadata: { locale: "en" } });

    expect(task.status).toBe("pending");
    expect(task.goal).toBe("book a flight");
    expect(task.interactionId).toBe("i1");
    expect(task.roleId).toBeNull();
    expect(task.parentTaskId).toBeNull();
    expect(task.metadata).toEqual({ locale: "en" });
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("get() returns undefined for an unknown id", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });

    expect(nest.get("does-not-exist")).toBeUndefined();
  });

  it("assign() sets roleId and moves the task to assigned", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });

    const task = await nest.create({ goal: "run tests", interactionId: "i1" });
    const assigned = await nest.assign(task.id, "role-42");

    expect(assigned.status).toBe("assigned");
    expect(assigned.roleId).toBe("role-42");
    expect(nest.get(task.id)?.roleId).toBe("role-42");
  });

  it("allows a non-terminal task to jump straight to a terminal state", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });

    const task = await nest.create({ goal: "run tests", interactionId: "i1" });
    const failed = await nest.transition(task.id, "failed");

    expect(failed.status).toBe("failed");
  });

  it("rejects transitioning an unknown task id", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });

    await expect(nest.transition("no-such-task", "running")).rejects.toThrow(TaskNotFoundError);
  });

  it("rejects an illegal transition with InvalidTaskTransitionError specifically", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });

    const task = await nest.create({ goal: "run tests", interactionId: "i1" });
    await nest.transition(task.id, "cancelled");

    await expect(nest.transition(task.id, "completed")).rejects.toThrow(InvalidTaskTransitionError);
  });

  it("persists each transition durably (visible to a fresh client reading the same file)", async () => {
    const dbPath = join(tempDir, "durable.sqlite3");
    const writer = await openDb(dbPath);
    const nest = new TaskNest({ db: writer });

    const task = await nest.create({ goal: "run tests", interactionId: "i1" });
    await nest.transition(task.id, "running");
    await writer.close();

    const reader = await DatabaseClient.open(dbPath);
    const { task: row } = await reader.request({ type: "task.get", id: task.id });
    await reader.close();

    expect(row?.status).toBe("running");
  });
});

describe("concurrent transitions on the same task", () => {
  it("serializes without a lost update: the second call observes the first call's synchronous state change", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });
    const task = await nest.create({ goal: "run tests", interactionId: "i1" });

    // Both calls start "simultaneously" via Promise.all, but TaskNest updates
    // its in-memory map synchronously before the first `await` inside
    // transition(), so the second call can only ever observe state at or
    // after the first call's synchronous update -- never a torn read.
    const results = await Promise.allSettled([
      nest.transition(task.id, "completed"),
      nest.transition(task.id, "blocked"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(nest.get(task.id)?.status).toBe("completed");
  });
});

describe("recoverPending", () => {
  it("reloads only non-terminal tasks from SQLite after a simulated restart", async () => {
    const dbPath = join(tempDir, "recover.sqlite3");

    const firstProcess = await openDb(dbPath);
    const firstNest = new TaskNest({ db: firstProcess });
    const active = await firstNest.create({ goal: "still going", interactionId: "i1" });
    const done = await firstNest.create({ goal: "already done", interactionId: "i1" });
    await firstNest.transition(done.id, "completed");
    await firstProcess.close();

    // Simulate a fresh process: a brand-new TaskNest (empty in-memory map)
    // backed by a brand-new DatabaseClient pointed at the same file.
    const secondProcess = await openDb(dbPath);
    const secondNest = new TaskNest({ db: secondProcess });
    const recovered = await secondNest.recoverPending();

    expect(recovered.map((t) => t.id)).toEqual([active.id]);
    expect(secondNest.get(active.id)?.status).toBe("pending");
    expect(secondNest.get(done.id)).toBeUndefined();
  });
});

describe("capacity cap", () => {
  it("evicts the oldest terminal-state task to admit a new one when full", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db, maxActiveTasks: 2 });

    const first = await nest.create({ goal: "first", interactionId: "i1" });
    await nest.transition(first.id, "completed");
    await nest.create({ goal: "second", interactionId: "i1" });

    expect(nest.size).toBe(2);

    await nest.create({ goal: "third", interactionId: "i1" });

    expect(nest.size).toBe(2);
    expect(nest.get(first.id)).toBeUndefined();
  });

  it("throws TaskNestCapacityError when full of only non-terminal tasks", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db, maxActiveTasks: 1 });

    await nest.create({ goal: "first", interactionId: "i1" });

    await expect(nest.create({ goal: "second", interactionId: "i1" })).rejects.toThrow(TaskNestCapacityError);
  });
});
