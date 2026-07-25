import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DatabaseClient,
  DatabaseClientClosedError,
  DatabaseRequestOverflowError,
} from "../../src/storage/database.js";

let tempDir: string;
let dbCounter = 0;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-db-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function nextDbPath(): string {
  dbCounter += 1;
  return join(tempDir, `test-${dbCounter}-${randomUUID()}.sqlite3`);
}

const baseTaskFields = {
  interactionId: "interaction-1",
  roleId: null,
  parentTaskId: null,
  metadata: {} as Record<string, unknown>,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("DatabaseClient worker boundary", () => {
  it("opens SQLite only inside the database worker", async () => {
    const db = await DatabaseClient.open(nextDbPath());

    expect(db.workerThreadId).not.toBe(0);
    expect(Number.isInteger(db.workerThreadId)).toBe(true);

    await db.close();
  });

  it("assigns a distinct workerThreadId to each opened client", async () => {
    const dbA = await DatabaseClient.open(nextDbPath());
    const dbB = await DatabaseClient.open(nextDbPath());

    expect(dbA.workerThreadId).not.toBe(dbB.workerThreadId);
    expect(dbA.workerThreadId).not.toBe(0);
    expect(dbB.workerThreadId).not.toBe(0);

    await Promise.all([dbA.close(), dbB.close()]);
  });
});

describe("request/response round trip", () => {
  it("round-trips a ping", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    await expect(db.request({ type: "ping" })).resolves.toEqual({ ok: true });
    await db.close();
  });

  it("inserts and reads back a task row", async () => {
    const db = await DatabaseClient.open(nextDbPath());

    const { task } = await db.request({
      type: "task.insert",
      task: { ...baseTaskFields, id: "task-1", goal: "translate the sentence", status: "pending", metadata: { source: "test" } },
    });

    expect(task.id).toBe("task-1");
    expect(task.status).toBe("pending");
    expect(JSON.parse(task.metadata)).toEqual({ source: "test" });

    const { task: reread } = await db.request({ type: "task.get", id: "task-1" });
    expect(reread).toEqual(task);

    await db.close();
  });

  it("returns undefined from task.get for an unknown id", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    const { task } = await db.request({ type: "task.get", id: "does-not-exist" });
    expect(task).toBeUndefined();
    await db.close();
  });

  it("updates task status and returns the updated row", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    await db.request({
      type: "task.insert",
      task: { ...baseTaskFields, id: "task-2", goal: "run tests", status: "pending" },
    });

    const { task } = await db.request({
      type: "task.update-status",
      update: { id: "task-2", status: "running", roleId: "role-1", updatedAt: "2026-01-01T00:05:00.000Z" },
    });

    expect(task?.status).toBe("running");
    expect(task?.role_id).toBe("role-1");
    expect(task?.updated_at).toBe("2026-01-01T00:05:00.000Z");

    await db.close();
  });

  it("task.update-status on an unknown id resolves with an undefined task rather than throwing", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    const { task } = await db.request({
      type: "task.update-status",
      update: { id: "ghost", status: "running", roleId: null, updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(task).toBeUndefined();
    await db.close();
  });

  it("lists only non-terminal tasks as active", async () => {
    const db = await DatabaseClient.open(nextDbPath());

    await db.request({ type: "task.insert", task: { ...baseTaskFields, id: "active-1", goal: "a", status: "pending" } });
    await db.request({ type: "task.insert", task: { ...baseTaskFields, id: "active-2", goal: "b", status: "running" } });
    await db.request({ type: "task.insert", task: { ...baseTaskFields, id: "done-1", goal: "c", status: "completed" } });
    await db.request({ type: "task.insert", task: { ...baseTaskFields, id: "done-2", goal: "d", status: "failed" } });

    const { tasks } = await db.request({ type: "task.list-active" });

    expect(tasks.map((t) => t.id).sort()).toEqual(["active-1", "active-2"]);

    await db.close();
  });

  it("persists a metrics sample", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    await expect(
      db.request({
        type: "metrics.record",
        sample: {
          recordedAt: "2026-01-01T00:00:00.000Z",
          eventLoopP50Ms: 1,
          eventLoopP95Ms: 2,
          eventLoopP99Ms: 3,
          rssBytes: 12_345,
          queueDepth: { outbound: 4 },
          dbLatencyP50Ms: 5,
          dbLatencyP95Ms: 6,
          dbLatencySampleCount: 10,
        },
      }),
    ).resolves.toEqual({ recorded: true });
    await db.close();
  });

  it("read commands observe writes still sitting in the batch buffer", async () => {
    const db = await DatabaseClient.open(nextDbPath());

    // Deliberately not awaited: both writes should still be sitting in the
    // worker's batch buffer when the read below is issued.
    const writes = [
      db.request({ type: "task.insert", task: { ...baseTaskFields, id: "w1", goal: "g1", status: "pending" } }),
      db.request({ type: "task.insert", task: { ...baseTaskFields, id: "w2", goal: "g2", status: "pending" } }),
    ];

    const { tasks } = await db.request({ type: "task.list-active" });
    expect(tasks.map((t) => t.id).sort()).toEqual(["w1", "w2"]);

    await Promise.all(writes);
    await db.close();
  });

  it("batches many rapid writes every 20ms/50-commands without losing any of them", async () => {
    const db = await DatabaseClient.open(nextDbPath());

    const inserts = Array.from({ length: 120 }, (_, i) =>
      db.request({
        type: "task.insert",
        task: { ...baseTaskFields, id: `task-${i}`, goal: `goal ${i}`, status: "pending" },
      }),
    );
    await Promise.all(inserts);

    const { tasks } = await db.request({ type: "task.list-active" });
    expect(tasks).toHaveLength(120);

    await db.close();
  });
});

describe("close path", () => {
  it("rejects new requests once closed", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    await db.close();

    expect(db.isClosed).toBe(true);
    await expect(db.request({ type: "ping" })).rejects.toThrow(DatabaseClientClosedError);
  });

  it("is idempotent", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    await db.close();
    await expect(db.close()).resolves.toBeUndefined();
  });

  it("does not leave pending requests dangling across close", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    expect(db.pendingRequestCount).toBe(0);
    await db.close();
    expect(db.pendingRequestCount).toBe(0);
  });
});

describe("in-flight request cap", () => {
  it("rejects a new request once at the configured cap", async () => {
    const db = await DatabaseClient.open(nextDbPath(), { maxPendingRequests: 1, requestTimeoutMs: 0 });

    const first = db.request({ type: "task.list-active" });
    await expect(db.request({ type: "ping" })).rejects.toThrow(DatabaseRequestOverflowError);

    await first;
    await db.close();
  });
});

describe("DB latency observability", () => {
  it("invokes onLatencySample after each successful request", async () => {
    const samples: number[] = [];
    const db = await DatabaseClient.open(nextDbPath(), { onLatencySample: (ms) => samples.push(ms) });

    await db.request({ type: "ping" });

    expect(samples).toHaveLength(1);
    expect(samples[0]).toBeGreaterThanOrEqual(0);

    await db.close();
  });
});

describe("task.assimilate -- one transaction across tasks/roles/role_fitness/pheromones/memories", () => {
  it("commits the task's final status, role fitness deltas, and a pheromone delta in one call", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    await db.request({
      type: "task.insert",
      task: { ...baseTaskFields, id: "assim-1", goal: "send the report", status: "running" },
    });

    const result = await db.request({
      type: "task.assimilate",
      assimilation: {
        taskId: "assim-1",
        finalStatus: "completed",
        roleId: "mail",
        roleName: "Mail Worker",
        roleStatus: "resident",
        roleFitness: [
          { metric: "task_outcome", value: 1 },
          { metric: "verification_status", value: 1 },
        ],
        pheromone: { signal: "mail.sendmail*phone-1home-wifi", strength: 0.8, decaysAt: null },
        memory: null,
        updatedAt: "2026-01-01T00:10:00.000Z",
      },
    });

    expect(result.task?.status).toBe("completed");
    expect(result.roleFitnessRecorded).toBe(2);
    expect(result.pheromoneRecorded).toBe(true);
    expect(result.memoryRecorded).toBe(false);

    const { task: reread } = await db.request({ type: "task.get", id: "assim-1" });
    expect(reread?.status).toBe("completed");
    expect(reread?.updated_at).toBe("2026-01-01T00:10:00.000Z");

    await db.close();
  });

  it("also writes a compressed memory row when one is supplied", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    await db.request({
      type: "task.insert",
      task: { ...baseTaskFields, id: "assim-2", goal: "answer a question", status: "running" },
    });

    const result = await db.request({
      type: "task.assimilate",
      assimilation: {
        taskId: "assim-2",
        finalStatus: "completed",
        roleId: "general",
        roleName: "General Worker",
        roleStatus: "resident",
        roleFitness: [{ metric: "task_outcome", value: 1 }],
        pheromone: null,
        memory: { id: randomUUID(), key: "task-summary:assim-2", value: "answered the user's question about billing" },
        updatedAt: "2026-01-01T00:11:00.000Z",
      },
    });

    expect(result.memoryRecorded).toBe(true);
    expect(result.pheromoneRecorded).toBe(false);

    await db.close();
  });

  it("upserts the same role's roles row across repeated assimilations instead of failing on the second call", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    await db.request({
      type: "task.insert",
      task: { ...baseTaskFields, id: "assim-3a", goal: "task one", status: "running" },
    });
    await db.request({
      type: "task.insert",
      task: { ...baseTaskFields, id: "assim-3b", goal: "task two", status: "running" },
    });

    await db.request({
      type: "task.assimilate",
      assimilation: {
        taskId: "assim-3a",
        finalStatus: "completed",
        roleId: "mail-trial",
        roleName: "Mail Worker (trial)",
        roleStatus: "trial",
        roleFitness: [{ metric: "task_outcome", value: 1 }],
        pheromone: null,
        memory: null,
        updatedAt: "2026-01-01T00:12:00.000Z",
      },
    });

    // Same roleId, second task, promoted status -- must not throw a
    // roles.id primary-key violation (proves the upsert, not a plain
    // insert, is what's actually wired up).
    await expect(
      db.request({
        type: "task.assimilate",
        assimilation: {
          taskId: "assim-3b",
          finalStatus: "completed",
          roleId: "mail-trial",
          roleName: "Mail Worker (trial)",
          roleStatus: "resident",
          roleFitness: [{ metric: "task_outcome", value: 1 }],
          pheromone: null,
          memory: null,
          updatedAt: "2026-01-01T00:13:00.000Z",
        },
      }),
    ).resolves.toMatchObject({ roleFitnessRecorded: 1 });

    await db.close();
  });

  it("rolls back the entire transaction -- including the task status update -- when one statement fails", async () => {
    const db = await DatabaseClient.open(nextDbPath());
    await db.request({
      type: "task.insert",
      task: { ...baseTaskFields, id: "assim-atomic", goal: "an atomic task", status: "running" },
    });

    // A malformed role_fitness metric (NOT NULL violation) sneaked past the
    // TS types, exactly as a corrupt/adversarial postMessage payload would
    // arrive at the worker boundary -- the point is to force a failure
    // partway through the transaction (after the task-status statement has
    // already run) and confirm nothing from this call is left durable.
    await expect(
      db.request({
        type: "task.assimilate",
        assimilation: {
          taskId: "assim-atomic",
          finalStatus: "completed",
          roleId: "mail",
          roleName: "Mail Worker",
          roleStatus: "resident",
          roleFitness: [{ metric: null as unknown as string, value: 1 }],
          pheromone: null,
          memory: null,
          updatedAt: "2026-01-01T00:14:00.000Z",
        },
      }),
    ).rejects.toThrow();

    const { task: reread } = await db.request({ type: "task.get", id: "assim-atomic" });
    expect(reread?.status).toBe("running");
    expect(reread?.updated_at).toBe(baseTaskFields.updatedAt);

    await db.close();
  });
});
