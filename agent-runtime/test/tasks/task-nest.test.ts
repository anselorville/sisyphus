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

describe("idempotent create via metadata.sourceEventId", () => {
  it("returns the existing task instead of creating a duplicate for a repeated sourceEventId", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });

    const first = await nest.create({ goal: "send the report", interactionId: "i1", metadata: { sourceEventId: "evt-1" } });
    const second = await nest.create({ goal: "send the report", interactionId: "i1", metadata: { sourceEventId: "evt-1" } });

    expect(second.id).toBe(first.id);
    expect(nest.size).toBe(1);
  });

  it("still creates distinct tasks when sourceEventId differs or is absent", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db });

    await nest.create({ goal: "a", interactionId: "i1", metadata: { sourceEventId: "evt-a" } });
    await nest.create({ goal: "b", interactionId: "i1", metadata: { sourceEventId: "evt-b" } });
    await nest.create({ goal: "c", interactionId: "i1" });
    await nest.create({ goal: "d", interactionId: "i1" });

    expect(nest.size).toBe(4);
  });

  it("recognizes a sourceEventId recovered from a prior process, not just one created this process lifetime", async () => {
    const dbPath = join(tempDir, "idempotent-recover.sqlite3");

    const firstProcess = await openDb(dbPath);
    const firstNest = new TaskNest({ db: firstProcess });
    const original = await firstNest.create({
      goal: "email me a summary",
      interactionId: "conv-crash",
      metadata: { sourceEventId: "evt-crash-1" },
    });
    await firstProcess.close();

    // Simulated restart: brand-new TaskNest, same db file, event redelivered
    // after recoverPending() -- exactly the crash-recovery race this
    // mechanism exists to close (see IDEMPOTENCY_METADATA_KEY's doc comment).
    const secondProcess = await openDb(dbPath);
    const secondNest = new TaskNest({ db: secondProcess });
    await secondNest.recoverPending();

    const redelivered = await secondNest.create({
      goal: "email me a summary",
      interactionId: "conv-crash",
      metadata: { sourceEventId: "evt-crash-1" },
    });

    expect(redelivered.id).toBe(original.id);
    expect(secondNest.size).toBe(1);
  });

  it("does not block a fresh task once the earlier task with the same sourceEventId has been evicted", async () => {
    const db = await openDb();
    const nest = new TaskNest({ db, maxActiveTasks: 2 });

    const first = await nest.create({ goal: "first", interactionId: "i1", metadata: { sourceEventId: "evt-1" } });
    await nest.transition(first.id, "completed");
    await nest.create({ goal: "second", interactionId: "i1" });
    // Hits capacity (size 2 >= cap 2): evicts `first` (the only terminal
    // task) to make room -- which also clears "evt-1" from
    // byIdempotencyKey (see TaskNest.removeIdempotencyIndexFor).
    const third = await nest.create({ goal: "third", interactionId: "i1" });
    expect(nest.get(first.id)).toBeUndefined(); // confirms first really was evicted

    await nest.transition(third.id, "completed");
    // Reusing "evt-1" now must create a genuinely new task -- proving the
    // stale index entry was actually cleared, not just coincidentally safe
    // because of the `tasks.get()` miss inside create()'s idempotency check.
    const fourth = await nest.create({ goal: "fourth", interactionId: "i1", metadata: { sourceEventId: "evt-1" } });

    expect(fourth.id).not.toBe(first.id);
    expect(fourth.goal).toBe("fourth");
    expect(nest.size).toBe(2);
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

describe("onTerminalTransition hook (Roadmap #3: task ends -> assimilate)", () => {
  it("is called once a transition lands on a terminal status, with the already-updated record", async () => {
    const db = await openDb();
    const calls: Array<{ id: string; status: string }> = [];
    const nest = new TaskNest({
      db,
      onTerminalTransition: (task) => {
        calls.push({ id: task.id, status: task.status });
      },
    });

    const task = await nest.create({ goal: "run tests", interactionId: "i1" });
    await nest.transition(task.id, "completed");

    expect(calls).toEqual([{ id: task.id, status: "completed" }]);
  });

  it("is never called for a non-terminal transition", async () => {
    const db = await openDb();
    let calls = 0;
    const nest = new TaskNest({ db, onTerminalTransition: () => { calls++; } });

    const task = await nest.create({ goal: "run tests", interactionId: "i1" });
    await nest.assign(task.id, "role-1");
    await nest.transition(task.id, "running");

    expect(calls).toBe(0);
  });

  it("is awaited before transition() resolves", async () => {
    const db = await openDb();
    let hookResolved = false;
    const nest = new TaskNest({
      db,
      onTerminalTransition: async () => {
        await Promise.resolve();
        hookResolved = true;
      },
    });

    const task = await nest.create({ goal: "run tests", interactionId: "i1" });
    await nest.transition(task.id, "completed");

    expect(hookResolved).toBe(true);
  });

  it("fires for each of completed/failed/cancelled", async () => {
    const db = await openDb();
    const statuses: string[] = [];
    const nest = new TaskNest({ db, onTerminalTransition: (task) => { statuses.push(task.status); } });

    const a = await nest.create({ goal: "a", interactionId: "i1" });
    const b = await nest.create({ goal: "b", interactionId: "i1" });
    const c = await nest.create({ goal: "c", interactionId: "i1" });
    await nest.transition(a.id, "completed");
    await nest.transition(b.id, "failed");
    await nest.transition(c.id, "cancelled");

    expect(statuses.sort()).toEqual(["cancelled", "completed", "failed"]);
  });
});
