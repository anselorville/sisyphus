import { useReducer } from "react";

/**
 * Mirrors agent-runtime/src/tasks/task-nest.ts's `TaskStatus` vocabulary
 * exactly (see `TASK_STATUSES` there). Declared independently here (not
 * imported) -- the client bundle has no build dependency on the agent-runtime
 * TypeScript package and never should; this is a deliberate duplication of a
 * small, stable vocabulary, not a shortcut.
 */
export const AGENT_TASK_STATUSES = [
  "pending",
  "assigned",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set(["completed", "failed", "cancelled"]);

/**
 * Mirrors task-nest.ts's `ALLOWED_TRANSITIONS` graph -- kept in lockstep with
 * that table on purpose (see this module's doc comment above) rather than
 * inventing a separate client-side rule. Re-validated here because THIS copy
 * is fed by network messages off a data channel, never by a trusted
 * in-process call like the sidecar's own copy is -- a stale, duplicate, or
 * out-of-order message must never be able to move a task backwards.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<AgentTaskStatus, ReadonlySet<AgentTaskStatus>>> = {
  pending: new Set(["assigned", "running", "blocked", "cancelled", "completed", "failed"]),
  assigned: new Set(["running", "blocked", "cancelled", "completed", "failed"]),
  running: new Set(["blocked", "completed", "failed", "cancelled"]),
  blocked: new Set(["running", "cancelled", "failed"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

/**
 * Wire shape for one task-lifecycle event arriving over the data channel --
 * see useAgentConnection.ts's documented wire-shape extension for the full
 * envelope this is part of. `task_id` is the only field every variant needs;
 * the rest are the small set of payload fields Voice Herald
 * (agent-runtime/src/voice/voice-herald.ts) already treats as meaningful, so
 * this reducer speaks the same vocabulary a human would eventually hear.
 * Fields are `unknown`-typed on purpose (this is untrusted network input,
 * narrowed defensively by readString()/statusForEventType() below) rather
 * than trusting a wire message to actually match its declared shape.
 */
export interface AgentTaskWireEvent {
  readonly type: string;
  readonly task_id?: unknown;
  readonly timestamp?: unknown;
  readonly goal?: unknown;
  readonly role_id?: unknown;
  readonly text?: unknown;
  readonly summary?: unknown;
  readonly reason?: unknown;
}

export interface AgentTask {
  readonly id: string;
  readonly goal: string;
  readonly status: AgentTaskStatus;
  /**
   * Human-readable detail for the current status: the latest progress note
   * while running, the completion summary once completed, or the failure
   * reason once failed. Never raw tool/JSON output -- mirrors Voice Herald's
   * own content-safety principle (chain-of-thought/tool dumps are never
   * user-facing text, spoken or displayed).
   */
  readonly detail?: string;
  readonly roleId?: string;
  readonly updatedAt: number;
}

export interface AgentTasksState {
  readonly tasks: readonly AgentTask[];
}

const INITIAL_STATE: AgentTasksState = { tasks: [] };

function statusForEventType(type: string): AgentTaskStatus | undefined {
  switch (type) {
    case "task.created":
      return "pending";
    case "task.assigned":
      return "assigned";
    case "task.progress":
      return "running";
    case "task.completed":
      return "completed";
    case "task.failed":
      return "failed";
    case "task.cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Pure state-reduction step: feeds ONE wire event into the current task list
 * and returns the next one. Exported standalone (not just embedded in
 * useAgentTasks()) specifically so it is directly unit-testable without
 * rendering React at all -- see useAgentTasks.test.ts.
 *
 * Two safety properties this upholds no matter how the transport reorders or
 * repeats delivery (a WebRTC data channel is ordered+reliable within ONE
 * connection, but a reconnect -- or a future durable-replay-on-resume design
 * on the sidecar side -- can still hand this the same event twice, or events
 * for the same task slightly out of order):
 *
 *   1. Re-applying an event for a task_id already present never adds a
 *      second entry for that id -- always an upsert keyed by task_id, never
 *      a push.
 *   2. A task already in a terminal state (completed/failed/cancelled) is
 *      absorbing: no later event for that task_id can move it to a
 *      different status, matching ALLOWED_TRANSITIONS above exactly (every
 *      terminal status maps to an empty allowed-set).
 *
 * An event for a task_id this reducer has never seen (task.created was lost,
 * arrived out of order, or was never sent) synthesizes a minimal task entry
 * instead of silently dropping real signal -- better to show "Untitled task"
 * than to lose a live task from the panel entirely.
 */
export function reduceAgentTasks(state: AgentTasksState, event: AgentTaskWireEvent): AgentTasksState {
  const taskId = readString(event.task_id);
  const nextStatus = statusForEventType(event.type);
  if (taskId === undefined || nextStatus === undefined) {
    return state; // not a task-lifecycle event (or malformed) -- ignored, not an error
  }

  const detailFromEvent = readString(event.text) ?? readString(event.summary) ?? readString(event.reason);
  const existingIndex = state.tasks.findIndex((task) => task.id === taskId);

  if (existingIndex === -1) {
    const created: AgentTask = {
      id: taskId,
      goal: readString(event.goal) ?? "Untitled task",
      status: nextStatus,
      detail: detailFromEvent,
      roleId: readString(event.role_id),
      updatedAt: Date.now(),
    };
    return { tasks: [...state.tasks, created] };
  }

  const existing = state.tasks[existingIndex];
  if (TERMINAL_STATUSES.has(existing.status)) {
    return state; // absorbing -- see doc comment above
  }
  if (nextStatus !== existing.status && !ALLOWED_TRANSITIONS[existing.status].has(nextStatus)) {
    return state; // illegal/stale transition for a live task -- ignore rather than guess
  }

  const updated: AgentTask = {
    ...existing,
    goal: readString(event.goal) ?? existing.goal,
    status: nextStatus,
    detail: detailFromEvent ?? existing.detail,
    roleId: readString(event.role_id) ?? existing.roleId,
    updatedAt: Date.now(),
  };
  const nextTasks = state.tasks.slice();
  nextTasks[existingIndex] = updated;
  return { tasks: nextTasks };
}

export interface UseAgentTasksResult {
  readonly tasks: readonly AgentTask[];
  /**
   * Feeds one wire event (of ANY recognized type) into the reducer; a no-op
   * for anything that isn't a task-lifecycle event. Stable identity (backed
   * by useReducer's dispatch) -- safe to use as an effect dependency without
   * causing extra re-runs.
   */
  readonly dispatch: (event: AgentTaskWireEvent) => void;
}

/** Thin React binding over reduceAgentTasks() -- see that function for the actual state-reduction rules. */
export function useAgentTasks(): UseAgentTasksResult {
  const [state, dispatch] = useReducer(reduceAgentTasks, INITIAL_STATE);
  return { tasks: state.tasks, dispatch };
}
