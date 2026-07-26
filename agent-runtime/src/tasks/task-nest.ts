/**
 * Task Nest: the in-process task tree for the agent-runtime sidecar.
 *
 * The in-memory `tasks` Map is the authoritative source of truth for a
 * task's current status, not SQLite. This isn't a distributed system --
 * everything runs on one Node process -- so the simplest correct way to
 * avoid a read-then-write race between two concurrent `transition()` calls
 * on the same task is to validate and update the map *synchronously*,
 * before the first `await`. JavaScript never preempts a synchronous run, so
 * a second `transition()` call (even one already "in flight" via
 * `Promise.all`) can only observe the map *after* the first call's
 * synchronous prefix has finished updating it. SQLite (via DatabaseClient,
 * itself backed by the DB Worker -- see ../storage/database.ts) exists for
 * durability and crash recovery (`recoverPending()`), not as the
 * concurrency-control mechanism.
 */

import { randomUUID } from "node:crypto";

import type { DatabaseClient, TaskRow } from "../storage/database.js";

export const TASK_STATUSES = [
  "pending",
  "assigned",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

/**
 * Allowed forward transitions per state. Any non-terminal state may jump
 * straight to a terminal one (fail-fast / cancel-anytime / instant-complete
 * semantics -- a task need not pass through "assigned"/"running" to be
 * marked done), but terminal states are absorbing: nothing transitions out
 * of `completed`, `failed`, or `cancelled`.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  pending: new Set(["assigned", "running", "blocked", "cancelled", "completed", "failed"]),
  assigned: new Set(["running", "blocked", "cancelled", "completed", "failed"]),
  running: new Set(["blocked", "completed", "failed", "cancelled"]),
  blocked: new Set(["running", "cancelled", "failed"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export interface TaskRecord {
  readonly id: string;
  readonly goal: string;
  readonly interactionId: string;
  readonly status: TaskStatus;
  readonly roleId: string | null;
  readonly parentTaskId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskInput {
  readonly goal: string;
  readonly interactionId: string;
  readonly parentTaskId?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Reserved `metadata` key: when a caller sets `metadata.sourceEventId` on
 * create(), create() becomes idempotent for that value -- a second create()
 * call carrying the same sourceEventId returns the already-existing task
 * instead of making a duplicate. This exists specifically to make crash
 * recovery safe: RuntimeWebSocketServer's own inbound-event dedup
 * (../transport/websocket-server.ts's seenInboundEventIds) lives only in
 * memory for one connection and does not survive a reconnect, so a durable
 * event whose ack was lost to a crash can arrive at a fresh connection and
 * reach create() a second time -- exactly the case
 * ../tasks/inbound-event-router.ts's `metadata: { sourceEventId: event.event_id }`
 * is written to guard against. Checked/populated by both create() and
 * recoverPending(), so the guarantee holds across a restart, not just within
 * one process lifetime.
 */
const IDEMPOTENCY_METADATA_KEY = "sourceEventId";

function readIdempotencyKey(metadata: Record<string, unknown>): string | undefined {
  const value = metadata[IDEMPOTENCY_METADATA_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`no task found with id "${taskId}"`);
    this.name = "TaskNotFoundError";
  }
}

export class InvalidTaskTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`invalid transition from "${from}" to "${to}"`);
    this.name = "InvalidTaskTransitionError";
  }
}

export class TaskNestCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNestCapacityError";
  }
}

export interface TaskNestOptions {
  readonly db: DatabaseClient;
  /** Bounded cap on in-memory active tasks; the overflow policy is to evict the oldest terminal-state task to make room, or throw if none exists. */
  readonly maxActiveTasks?: number;
  readonly now?: () => Date;
  /**
   * Called once a transition lands on a terminal status (completed/failed/
   * cancelled), after the transition's own durable `task.update-status`
   * write has already succeeded -- the natural "task ends" hook point named
   * in ../README.md's roadmap item 3 (see ../tasks/task-assimilation.ts's
   * createTaskAssimilationHook() for the real production implementation).
   * Awaited by transition()/assign() before they resolve; never called for
   * a non-terminal transition. Errors are this hook's own responsibility to
   * swallow (task-assimilation.ts's onError does exactly that) -- a hook
   * that throws will reject the transition() call even though the
   * transition itself already durably committed, so a caller supplying one
   * should never let it throw.
   */
  readonly onTerminalTransition?: (task: TaskRecord) => void | Promise<void>;
}

const DEFAULT_MAX_ACTIVE_TASKS = 2000;

export class TaskNest {
  private readonly db: DatabaseClient;
  private readonly maxActiveTasks: number;
  private readonly now: () => Date;
  private readonly onTerminalTransition: (task: TaskRecord) => void | Promise<void>;
  private readonly tasks = new Map<string, TaskRecord>();
  /** sourceEventId (see IDEMPOTENCY_METADATA_KEY) -> taskId, for every task currently held in memory. Kept in lockstep with `tasks`: populated by create()/recoverPending(), pruned by evictOldestTerminal() -- never grows past `tasks`' own size. */
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(options: TaskNestOptions) {
    this.db = options.db;
    this.maxActiveTasks = options.maxActiveTasks ?? DEFAULT_MAX_ACTIVE_TASKS;
    this.now = options.now ?? ((): Date => new Date());
    this.onTerminalTransition = options.onTerminalTransition ?? ((): void => {});
  }

  /** Number of tasks currently held in memory. */
  get size(): number {
    return this.tasks.size;
  }

  /** Reads a task from the in-memory nest (does not hit the DB Worker). `undefined` if unknown or already evicted. */
  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Creates a new task in `pending` status, durably persisted through the DB
   * Worker before returning. Idempotent when `input.metadata.sourceEventId`
   * is set (see IDEMPOTENCY_METADATA_KEY): a call carrying a sourceEventId
   * that already maps to a task currently held in memory returns that
   * existing record unchanged -- no new task, no capacity consumed, no DB
   * write -- rather than creating a duplicate.
   */
  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const metadata = input.metadata ?? {};
    const idempotencyKey = readIdempotencyKey(metadata);
    if (idempotencyKey !== undefined) {
      const existingId = this.byIdempotencyKey.get(idempotencyKey);
      const existing = existingId !== undefined ? this.tasks.get(existingId) : undefined;
      if (existing) {
        return existing;
      }
    }

    this.reserveCapacity();

    const timestamp = this.now().toISOString();
    const record: TaskRecord = {
      id: randomUUID(),
      goal: input.goal,
      interactionId: input.interactionId,
      status: "pending",
      roleId: null,
      parentTaskId: input.parentTaskId ?? null,
      metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Synchronous, before any `await`: see the module doc comment.
    this.tasks.set(record.id, record);
    if (idempotencyKey !== undefined) {
      this.byIdempotencyKey.set(idempotencyKey, record.id);
    }

    await this.db.request({
      type: "task.insert",
      task: {
        id: record.id,
        goal: record.goal,
        interactionId: record.interactionId,
        status: record.status,
        roleId: record.roleId,
        parentTaskId: record.parentTaskId,
        metadata: record.metadata,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });

    return record;
  }

  /** Assigns a task to a role and transitions it to `assigned` in one step. */
  async assign(taskId: string, roleId: string): Promise<TaskRecord> {
    return this.applyTransition(taskId, "assigned", roleId);
  }

  /** Moves a task to `to`, validating against the allowed-transition graph. Rejects with InvalidTaskTransitionError without ever contacting the DB Worker if the transition is illegal. */
  async transition(taskId: string, to: TaskStatus): Promise<TaskRecord> {
    return this.applyTransition(taskId, to, undefined);
  }

  /**
   * Reloads every non-terminal task from SQLite into the in-memory nest.
   * Meant to run once at startup (this process's own restart, after a
   * crash) since the in-memory Map always starts empty while SQLite still
   * holds whatever was durable before the process died. Respects the same
   * capacity cap as `create()`.
   */
  async recoverPending(): Promise<readonly TaskRecord[]> {
    const { tasks: rows } = await this.db.request({ type: "task.list-active" });
    const recovered: TaskRecord[] = [];

    for (const row of rows) {
      if (this.tasks.size >= this.maxActiveTasks && !this.tasks.has(row.id)) {
        break; // Cap respected; anything left over stays durable in SQLite for a later recovery pass.
      }
      const record = fromRow(row);
      this.tasks.set(record.id, record);
      const idempotencyKey = readIdempotencyKey(record.metadata);
      if (idempotencyKey !== undefined) {
        this.byIdempotencyKey.set(idempotencyKey, record.id);
      }
      recovered.push(record);
    }

    return recovered;
  }

  private async applyTransition(
    taskId: string,
    to: TaskStatus,
    roleId: string | undefined,
  ): Promise<TaskRecord> {
    const current = this.tasks.get(taskId);
    if (!current) {
      throw new TaskNotFoundError(taskId);
    }

    const allowed = ALLOWED_TRANSITIONS[current.status];
    if (!allowed.has(to)) {
      throw new InvalidTaskTransitionError(current.status, to);
    }

    const updated: TaskRecord = {
      ...current,
      status: to,
      roleId: roleId ?? current.roleId,
      updatedAt: this.now().toISOString(),
    };
    // Synchronous, before any `await`: see the module doc comment.
    this.tasks.set(taskId, updated);

    await this.db.request({
      type: "task.update-status",
      update: { id: taskId, status: updated.status, roleId: updated.roleId, updatedAt: updated.updatedAt },
    });

    if (TERMINAL_STATUSES.has(updated.status)) {
      await this.onTerminalTransition(updated);
    }

    return updated;
  }

  private reserveCapacity(): void {
    if (this.tasks.size < this.maxActiveTasks) {
      return;
    }
    if (!this.evictOldestTerminal()) {
      throw new TaskNestCapacityError(
        `task nest is full (capacity=${this.maxActiveTasks}) and holds no terminal-state task to evict`,
      );
    }
  }

  /** Map iteration order is insertion order, so the first terminal-state entry found is also the oldest one. */
  private evictOldestTerminal(): boolean {
    for (const [id, task] of this.tasks) {
      if (TERMINAL_STATUSES.has(task.status)) {
        this.tasks.delete(id);
        this.removeIdempotencyIndexFor(task);
        return true;
      }
    }
    return false;
  }

  /** Keeps byIdempotencyKey in lockstep with an evicted task -- never left pointing at an id no longer in `tasks`. */
  private removeIdempotencyIndexFor(task: TaskRecord): void {
    const idempotencyKey = readIdempotencyKey(task.metadata);
    if (idempotencyKey !== undefined && this.byIdempotencyKey.get(idempotencyKey) === task.id) {
      this.byIdempotencyKey.delete(idempotencyKey);
    }
  }
}

function fromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    goal: row.goal,
    interactionId: row.interaction_id,
    status: row.status as TaskStatus,
    roleId: row.role_id,
    parentTaskId: row.parent_task_id,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
