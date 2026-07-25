/**
 * Main-thread facing client for the sidecar's SQLite database.
 *
 * This module contains no `better-sqlite3` import anywhere -- deliberately.
 * SQLite must never open on the main thread; the only file allowed to
 * construct a `Database` is ./db-worker.ts, which runs exclusively inside a
 * `worker_threads.Worker`. Every call from application code (TaskNest,
 * RuntimeMetrics, ...) goes through `DatabaseClient.request()`, an async
 * `postMessage` round trip to that worker. The main event loop never blocks
 * on a DB call.
 *
 * `DbCommand` / `DbCommandResultMap` form the typed wire protocol between
 * this file and db-worker.ts: a discriminated union of every command the
 * worker knows how to execute, keyed to its exact result shape so
 * `request()` can return `Promise<DbCommandResultMap[C["type"]]>` instead of
 * `Promise<unknown>`.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// ---------------------------------------------------------------------------
// Row / input shapes shared with db-worker.ts
// ---------------------------------------------------------------------------

/** A `tasks` row exactly as stored (snake_case columns), mirroring the `events` table's convention of staying wire/row-shaped rather than camelCase. */
export interface TaskRow {
  readonly id: string;
  readonly goal: string;
  readonly interaction_id: string;
  readonly status: string;
  readonly role_id: string | null;
  readonly parent_task_id: string | null;
  readonly metadata: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TaskInsertInput {
  readonly id: string;
  readonly goal: string;
  readonly interactionId: string;
  readonly status: string;
  readonly roleId: string | null;
  readonly parentTaskId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskUpdateStatusInput {
  readonly id: string;
  readonly status: string;
  readonly roleId: string | null;
  readonly updatedAt: string;
}

export interface MetricsSampleInput {
  readonly recordedAt: string;
  readonly eventLoopP50Ms: number;
  readonly eventLoopP95Ms: number;
  readonly eventLoopP99Ms: number;
  readonly rssBytes: number;
  readonly queueDepth: Record<string, number>;
  readonly dbLatencyP50Ms: number | null;
  readonly dbLatencyP95Ms: number | null;
  readonly dbLatencySampleCount: number;
}

// ---------------------------------------------------------------------------
// Command / result protocol
// ---------------------------------------------------------------------------
//
// This is deliberately narrower than the full table set migrations.ts
// creates: `events`, `roles`, `role_fitness`, `budgets`, `pheromones`, and
// `memories` exist per the schema spec so later work can build on them, but
// no command here reads or writes them yet -- only `tasks` (TaskNest) and
// `runtime_metrics` (RuntimeMetrics) have an actual caller and a test behind
// them, per this task's own "write a failing test first, then minimal
// implementation" rule.

export interface DbCommandResultMap {
  ping: { readonly ok: true };
  "task.insert": { readonly task: TaskRow };
  "task.update-status": { readonly task: TaskRow | undefined };
  "task.get": { readonly task: TaskRow | undefined };
  "task.list-active": { readonly tasks: readonly TaskRow[] };
  "metrics.record": { readonly recorded: true };
}

export type DbCommand =
  | { readonly type: "ping" }
  | { readonly type: "task.insert"; readonly task: TaskInsertInput }
  | { readonly type: "task.update-status"; readonly update: TaskUpdateStatusInput }
  | { readonly type: "task.get"; readonly id: string }
  | { readonly type: "task.list-active" }
  | { readonly type: "metrics.record"; readonly sample: MetricsSampleInput };

/** `workerData` handed to db-worker.ts at spawn time. */
export interface DbWorkerData {
  readonly dbPath: string;
}

// ---------------------------------------------------------------------------
// postMessage envelope (exported as types only -- db-worker.ts imports these
// with `import type`, which is fully erased at compile time and therefore
// never becomes a runtime dependency on this file).
// ---------------------------------------------------------------------------

export interface WorkerRequestMessage {
  readonly kind: "request";
  readonly id: number;
  readonly command: DbCommand;
}
export interface WorkerShutdownMessage {
  readonly kind: "shutdown";
}
export type WorkerInboundMessage = WorkerRequestMessage | WorkerShutdownMessage;

export interface WorkerReadyMessage {
  readonly kind: "ready";
}
export interface WorkerResponseOkMessage {
  readonly kind: "response";
  readonly id: number;
  readonly ok: true;
  readonly result: unknown;
}
export interface WorkerResponseErrMessage {
  readonly kind: "response";
  readonly id: number;
  readonly ok: false;
  readonly error: { readonly name: string; readonly message: string };
}
export interface WorkerShutdownAckMessage {
  readonly kind: "shutdown-ack";
}
export type WorkerOutboundMessage =
  | WorkerReadyMessage
  | WorkerResponseOkMessage
  | WorkerResponseErrMessage
  | WorkerShutdownAckMessage;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DatabaseClientClosedError extends Error {
  constructor(message = "database client is closed") {
    super(message);
    this.name = "DatabaseClientClosedError";
  }
}

export class DatabaseRequestOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRequestOverflowError";
  }
}

export class DatabaseRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRequestTimeoutError";
  }
}

export class DatabaseWorkerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseWorkerError";
  }
}

// ---------------------------------------------------------------------------
// Worker entry resolution
// ---------------------------------------------------------------------------

/**
 * Prefers the compiled sibling (`npm run build` output) whenever it exists --
 * the normal, hook-free production path where every relative specifier
 * already points at a real `.js` file. Falls back to spawning the raw
 * TypeScript source (dev/test, no build step) with the resolve hook attached
 * *only* to that worker's own Node instance; see ts-worker-resolve-hook.mjs
 * for why the hook is needed at all.
 */
function resolveWorkerEntry(): { readonly url: URL; readonly execArgv: readonly string[] } {
  const compiled = new URL("./db-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(compiled))) {
    return { url: compiled, execArgv: [] };
  }

  const source = new URL("./db-worker.ts", import.meta.url);
  const registerHook = fileURLToPath(new URL("./register-ts-worker-hooks.mjs", import.meta.url));
  return { url: source, execArgv: ["--import", registerHook] };
}

// ---------------------------------------------------------------------------
// DatabaseClient
// ---------------------------------------------------------------------------

export interface DatabaseClientOptions {
  /** Bounded cap on concurrent in-flight requests; the overflow policy is to reject a new request immediately rather than let this grow without limit. */
  readonly maxPendingRequests?: number;
  /** Per-request timeout; 0 disables it. Guards against a wedged worker leaking a pending request forever. */
  readonly requestTimeoutMs?: number;
  /** Invoked with each request's round-trip latency in ms, on success only. Intended sink: RuntimeMetrics.recordDbLatency. */
  readonly onLatencySample?: (ms: number) => void;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout | undefined;
}

const DEFAULT_MAX_PENDING_REQUESTS = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_ACK_FALLBACK_MS = 2_000;

/**
 * The only handle application code should hold to the database. Every method
 * is async and every SQL operation actually happens inside the Worker
 * Thread spawned by `open()` -- this class itself never touches SQLite.
 */
export class DatabaseClient {
  private readonly worker: Worker;
  private readonly maxPendingRequests: number;
  private readonly requestTimeoutMs: number;
  private readonly onLatencySample: (ms: number) => void;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private closed = false;

  private constructor(worker: Worker, options: Required<DatabaseClientOptions>) {
    this.worker = worker;
    this.maxPendingRequests = options.maxPendingRequests;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.onLatencySample = options.onLatencySample;

    this.worker.on("message", (message: WorkerOutboundMessage) => this.handleMessage(message));
    this.worker.on("error", (error: Error) => {
      this.closed = true;
      this.rejectAllPending(new DatabaseWorkerError("database worker crashed", { cause: error }));
    });
    this.worker.on("exit", (code: number) => {
      if (!this.closed) {
        this.closed = true;
        this.rejectAllPending(new DatabaseWorkerError(`database worker exited unexpectedly (code ${code})`));
      }
    });
  }

  /** Spawns the database worker, waits for it to open SQLite and run migrations, and resolves once it reports ready. */
  static async open(dbPath: string, options: DatabaseClientOptions = {}): Promise<DatabaseClient> {
    const { url, execArgv } = resolveWorkerEntry();
    const workerData: DbWorkerData = { dbPath };
    const worker = new Worker(url, { execArgv: [...execArgv], workerData });

    await new Promise<void>((resolve, reject) => {
      const onMessage = (message: WorkerOutboundMessage): void => {
        if (message && message.kind === "ready") {
          cleanup();
          resolve();
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new DatabaseWorkerError("database worker failed during startup", { cause: error }));
      };
      const onExit = (code: number): void => {
        cleanup();
        reject(new DatabaseWorkerError(`database worker exited during startup (code ${code})`));
      };
      const cleanup = (): void => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };

      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
    });

    return new DatabaseClient(worker, {
      maxPendingRequests: options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      onLatencySample: options.onLatencySample ?? (() => {}),
    });
  }

  /** The database worker's `threadId` (see node:worker_threads). Always > 0 for a real worker thread; 0 is reserved for the main thread and is never a valid value here. */
  get workerThreadId(): number {
    return this.worker.threadId;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Sends one command to the database worker and resolves with its typed result. Never touches SQLite directly. */
  async request<C extends DbCommand>(command: C): Promise<DbCommandResultMap[C["type"]]> {
    if (this.closed) {
      throw new DatabaseClientClosedError();
    }
    if (this.pending.size >= this.maxPendingRequests) {
      throw new DatabaseRequestOverflowError(
        `database client already has ${this.pending.size} in-flight requests, at its cap of ${this.maxPendingRequests}`,
      );
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const startedAt = performance.now();

    const result = await new Promise<unknown>((resolve, reject) => {
      const timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new DatabaseRequestTimeoutError(
                  `database request "${command.type}" (#${id}) timed out after ${this.requestTimeoutMs}ms`,
                ),
              );
            }, this.requestTimeoutMs)
          : undefined;
      timer?.unref();

      this.pending.set(id, { resolve, reject, timer });

      const message: WorkerRequestMessage = { kind: "request", id, command };
      this.worker.postMessage(message);
    });

    this.onLatencySample(performance.now() - startedAt);
    return result as DbCommandResultMap[C["type"]];
  }

  /**
   * Flushes any batched writes, closes the SQLite handle inside the worker,
   * then terminates the thread. Idempotent -- safe to call more than once.
   * Any request still in flight when this settles is rejected so the
   * pending map never leaks.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.worker.off("message", onMessage);
        resolve();
      };
      const onMessage = (message: WorkerOutboundMessage): void => {
        if (message && message.kind === "shutdown-ack") {
          finish();
        }
      };
      this.worker.on("message", onMessage);
      const shutdown: WorkerShutdownMessage = { kind: "shutdown" };
      this.worker.postMessage(shutdown);

      // Don't let a wedged worker hang close() forever.
      setTimeout(finish, CLOSE_ACK_FALLBACK_MS).unref();
    });

    await this.worker.terminate();
    this.rejectAllPending(new DatabaseClientClosedError("database client closed"));
  }

  private handleMessage(message: WorkerOutboundMessage): void {
    if (!message || message.kind !== "response") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new DatabaseWorkerError(message.error.message));
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
