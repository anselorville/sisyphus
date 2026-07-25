/**
 * Database Worker entry point.
 *
 * This is the ONLY file in the codebase allowed to `import` `better-sqlite3`
 * or construct a `Database`. It runs exclusively inside a
 * `worker_threads.Worker` spawned by `DatabaseClient.open()` in ./database.ts
 * -- never on the main thread. All communication with the main thread is
 * async `postMessage`; see ./database.ts for the shared message protocol
 * types (`WorkerInboundMessage` / `WorkerOutboundMessage` / `DbCommand`).
 *
 * Writes are batched into a single transaction every `WRITE_BATCH_INTERVAL_MS`
 * or every `WRITE_BATCH_MAX_COMMANDS` queued writes, whichever comes first.
 * A read command flushes any pending batch first so callers always observe
 * their own prior writes, even ones still sitting in the batch buffer.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

import { runMigrations } from "./migrations.js";
import type {
  DbCommand,
  DbWorkerData,
  TaskRow,
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from "./database.js";

if (isMainThread || !parentPort) {
  throw new Error("db-worker.ts must only be run inside a Worker Thread, never on the main thread");
}

// Narrow, non-null alias so TypeScript's control-flow analysis doesn't force
// an `!` on every single use below (it can't see through closures created
// after this point, e.g. inside setTimeout callbacks).
const port = parentPort;

const { dbPath } = workerData as DbWorkerData;

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 2000");

runMigrations(db);

// ---------------------------------------------------------------------------
// Prepared statements (built once at worker startup, reused for every call)
// ---------------------------------------------------------------------------

interface TaskInsertBindParams {
  readonly id: string;
  readonly goal: string;
  readonly interactionId: string;
  readonly status: string;
  readonly roleId: string | null;
  readonly parentTaskId: string | null;
  readonly metadata: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TaskUpdateStatusBindParams {
  readonly id: string;
  readonly status: string;
  readonly roleId: string | null;
  readonly updatedAt: string;
}

interface MetricsInsertBindParams {
  readonly recordedAt: string;
  readonly eventLoopP50Ms: number;
  readonly eventLoopP95Ms: number;
  readonly eventLoopP99Ms: number;
  readonly rssBytes: number;
  readonly queueDepth: string;
  readonly dbLatencyP50Ms: number | null;
  readonly dbLatencyP95Ms: number | null;
  readonly dbLatencySampleCount: number;
}

const MAX_RUNTIME_METRICS_ROWS = 10_000;

const statements = {
  insertTask: db.prepare<TaskInsertBindParams>(`
    INSERT INTO tasks (id, goal, interaction_id, status, role_id, parent_task_id, metadata, created_at, updated_at)
    VALUES (@id, @goal, @interactionId, @status, @roleId, @parentTaskId, @metadata, @createdAt, @updatedAt)
  `),
  updateTaskStatus: db.prepare<TaskUpdateStatusBindParams>(`
    UPDATE tasks SET status = @status, role_id = @roleId, updated_at = @updatedAt WHERE id = @id
  `),
  getTask: db.prepare<[string], TaskRow>(`SELECT * FROM tasks WHERE id = ?`),
  listActiveTasks: db.prepare<[], TaskRow>(
    `SELECT * FROM tasks WHERE status NOT IN ('completed', 'failed', 'cancelled')`,
  ),
  insertMetricsSample: db.prepare<MetricsInsertBindParams>(`
    INSERT INTO runtime_metrics (
      recorded_at, event_loop_p50_ms, event_loop_p95_ms, event_loop_p99_ms,
      rss_bytes, queue_depth, db_latency_p50_ms, db_latency_p95_ms, db_latency_samples
    ) VALUES (
      @recordedAt, @eventLoopP50Ms, @eventLoopP95Ms, @eventLoopP99Ms,
      @rssBytes, @queueDepth, @dbLatencyP50Ms, @dbLatencyP95Ms, @dbLatencySampleCount
    )
  `),
  pruneMetrics: db.prepare<[number]>(
    `DELETE FROM runtime_metrics WHERE id NOT IN (SELECT id FROM runtime_metrics ORDER BY id DESC LIMIT ?)`,
  ),
};

// ---------------------------------------------------------------------------
// Write batching: every 20ms OR every 50 queued write commands, whichever
// comes first. Each queued entry still gets its own individual response the
// moment the batch it's part of actually commits -- batching only changes
// *when* a write executes, never whether the caller is told the truth about
// it.
// ---------------------------------------------------------------------------

const WRITE_BATCH_INTERVAL_MS = 20;
const WRITE_BATCH_MAX_COMMANDS = 50;

interface QueuedWrite {
  readonly run: () => unknown;
  readonly respond: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

let pendingWrites: QueuedWrite[] = [];
let flushTimer: NodeJS.Timeout | undefined;

function makeWriteEntry(id: number, run: () => unknown): QueuedWrite {
  return {
    run,
    respond: (result) => postResponse(id, true, result),
    reject: (error) => postResponse(id, false, undefined, error),
  };
}

function enqueueWrite(entry: QueuedWrite): void {
  pendingWrites.push(entry);
  if (pendingWrites.length >= WRITE_BATCH_MAX_COMMANDS) {
    flushPendingWrites();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushPendingWrites, WRITE_BATCH_INTERVAL_MS);
  }
}

function flushIfPending(): void {
  if (pendingWrites.length > 0) {
    flushPendingWrites();
  }
}

function flushPendingWrites(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (pendingWrites.length === 0) {
    return;
  }

  const batch = pendingWrites;
  pendingWrites = [];

  const applyBatch = db.transaction(() => {
    for (const entry of batch) {
      try {
        const result = entry.run();
        entry.respond(result);
      } catch (error) {
        // One bad statement in the batch must not sink everyone else's
        // already-good writes: report it and keep applying the rest.
        entry.reject(error);
      }
    }
  });

  try {
    applyBatch();
  } catch (error) {
    // The commit itself failed (e.g. disk full) after entries individually
    // looked fine -- nothing in the batch is durable, so tell everyone.
    for (const entry of batch) {
      entry.reject(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

function handleRequest(id: number, command: DbCommand): void {
  try {
    switch (command.type) {
      case "ping": {
        flushIfPending();
        postResponse(id, true, { ok: true });
        return;
      }
      case "task.get": {
        flushIfPending();
        const task = statements.getTask.get(command.id);
        postResponse(id, true, { task });
        return;
      }
      case "task.list-active": {
        flushIfPending();
        const tasks = statements.listActiveTasks.all();
        postResponse(id, true, { tasks });
        return;
      }
      case "task.insert": {
        const { task } = command;
        enqueueWrite(
          makeWriteEntry(id, () => {
            statements.insertTask.run({
              id: task.id,
              goal: task.goal,
              interactionId: task.interactionId,
              status: task.status,
              roleId: task.roleId,
              parentTaskId: task.parentTaskId,
              metadata: JSON.stringify(task.metadata),
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
            });
            return { task: statements.getTask.get(task.id) };
          }),
        );
        return;
      }
      case "task.update-status": {
        const { update } = command;
        enqueueWrite(
          makeWriteEntry(id, () => {
            statements.updateTaskStatus.run({
              id: update.id,
              status: update.status,
              roleId: update.roleId,
              updatedAt: update.updatedAt,
            });
            return { task: statements.getTask.get(update.id) };
          }),
        );
        return;
      }
      case "metrics.record": {
        const { sample } = command;
        enqueueWrite(
          makeWriteEntry(id, () => {
            statements.insertMetricsSample.run({
              recordedAt: sample.recordedAt,
              eventLoopP50Ms: sample.eventLoopP50Ms,
              eventLoopP95Ms: sample.eventLoopP95Ms,
              eventLoopP99Ms: sample.eventLoopP99Ms,
              rssBytes: sample.rssBytes,
              queueDepth: JSON.stringify(sample.queueDepth),
              dbLatencyP50Ms: sample.dbLatencyP50Ms,
              dbLatencyP95Ms: sample.dbLatencyP95Ms,
              dbLatencySampleCount: sample.dbLatencySampleCount,
            });
            statements.pruneMetrics.run(MAX_RUNTIME_METRICS_ROWS);
            return { recorded: true };
          }),
        );
        return;
      }
      default: {
        const exhaustive: never = command;
        postResponse(id, false, undefined, new Error(`unknown database command: ${JSON.stringify(exhaustive)}`));
        return;
      }
    }
  } catch (error) {
    postResponse(id, false, undefined, error);
  }
}

function postResponse(id: number, ok: boolean, result?: unknown, error?: unknown): void {
  const message: WorkerOutboundMessage = ok
    ? { kind: "response", id, ok: true, result }
    : { kind: "response", id, ok: false, error: describeError(error) };
  port.postMessage(message);
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function handleShutdown(): void {
  flushIfPending();
  db.close();
  const ack: WorkerOutboundMessage = { kind: "shutdown-ack" };
  port.postMessage(ack);
}

port.on("message", (raw: WorkerInboundMessage) => {
  if (!raw) {
    return;
  }
  if (raw.kind === "shutdown") {
    handleShutdown();
    return;
  }
  if (raw.kind === "request") {
    handleRequest(raw.id, raw.command);
  }
});

const ready: WorkerOutboundMessage = { kind: "ready" };
port.postMessage(ready);
