import { useState } from "react";
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Hourglass, ListTodo, Loader2, Pause, Send, X } from "lucide-react";
import { Badge, type BadgeTone } from "../../primitives/Badge";
import { Button } from "../../primitives/Button";
import type { AgentTask, AgentTaskStatus } from "../../../hooks/useAgentTasks";
import styles from "./TaskNestPanel.module.css";

export interface TaskNestPanelProps {
  tasks: readonly AgentTask[];
  onCancel: (taskId: string) => void;
  onSteer: (taskId: string, text: string) => void;
  onFollowUp: (taskId: string, text: string) => void;
}

const ACTIVE_STATUSES: ReadonlySet<AgentTaskStatus> = new Set(["assigned", "running", "blocked"]);
const DONE_STATUSES: ReadonlySet<AgentTaskStatus> = new Set(["completed", "failed", "cancelled"]);
const MAX_DONE_SHOWN = 4;

const STATUS_ICON: Record<AgentTaskStatus, ReactNode> = {
  pending: <Hourglass size={14} />,
  assigned: <Hourglass size={14} />,
  running: <Loader2 size={14} className={styles.spin} />,
  blocked: <Pause size={14} />,
  completed: <CircleCheck size={14} />,
  failed: <CircleAlert size={14} />,
  cancelled: <X size={14} />,
};

const STATUS_TONE: Record<AgentTaskStatus, BadgeTone> = {
  pending: "neutral",
  assigned: "accent",
  running: "primary",
  blocked: "accent",
  completed: "secondary",
  failed: "danger",
  cancelled: "neutral",
};

const STATUS_LABEL: Record<AgentTaskStatus, string> = {
  pending: "Queued",
  assigned: "Assigned",
  running: "Running",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Current task(s) and queue. Groups the flat task list into Active (assigned
 * / running / blocked), Queued (pending), and a short recent Done tail
 * (completed / failed / cancelled, capped at MAX_DONE_SHOWN) -- rather than
 * having the underlying hook pre-split the list, this presentational
 * component owns the grouping so Storybook fixtures can just be a flat
 * array.
 */
export function TaskNestPanel({ tasks, onCancel, onSteer, onFollowUp }: TaskNestPanelProps) {
  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const queued = tasks.filter((task) => task.status === "pending");
  const done = tasks.filter((task) => DONE_STATUSES.has(task.status)).slice(-MAX_DONE_SHOWN).reverse();

  if (tasks.length === 0) {
    return (
      <section className={styles.panel} aria-label="Tasks">
        <h2 className={styles.heading}>
          <ListTodo size={16} /> Tasks
        </h2>
        <p className={styles.empty}>No active tasks. Ask me to do something to get started.</p>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-label="Tasks">
      <h2 className={styles.heading}>
        <ListTodo size={16} /> Tasks
      </h2>

      {active.length > 0 && (
        <ul className={styles.list}>
          {active.map((task) => (
            <TaskRow key={task.id} task={task} onCancel={onCancel} onSteer={onSteer} onFollowUp={onFollowUp} />
          ))}
        </ul>
      )}

      {queued.length > 0 && (
        <div className={styles.group}>
          <h3 className={styles.groupHeading}>Queued ({queued.length})</h3>
          <ul className={styles.list}>
            {queued.map((task) => (
              <TaskRow key={task.id} task={task} onCancel={onCancel} onSteer={onSteer} onFollowUp={onFollowUp} />
            ))}
          </ul>
        </div>
      )}

      {done.length > 0 && (
        <div className={styles.group}>
          <h3 className={styles.groupHeading}>Recently finished</h3>
          <ul className={styles.list}>
            {done.map((task) => (
              <TaskRow key={task.id} task={task} onCancel={onCancel} onSteer={onSteer} onFollowUp={onFollowUp} muted />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

interface TaskRowProps {
  task: AgentTask;
  onCancel: (taskId: string) => void;
  onSteer: (taskId: string, text: string) => void;
  onFollowUp: (taskId: string, text: string) => void;
  muted?: boolean;
}

function TaskRow({ task, onCancel, onSteer, onFollowUp, muted = false }: TaskRowProps) {
  const [messageOpen, setMessageOpen] = useState(false);
  const [message, setMessage] = useState("");
  const isTerminal = task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  // Steering/interrupting a turn only makes sense once a role is actually
  // mid-turn; queued/assigned-but-not-yet-running tasks can only be
  // cancelled.
  const canMessage = task.status === "running";

  const submit = (send: (taskId: string, text: string) => void) => {
    const trimmed = message.trim();
    if (trimmed === "") return;
    send(task.id, trimmed);
    setMessage("");
    setMessageOpen(false);
  };

  return (
    <li className={styles.row} data-muted={muted}>
      <div className={styles.rowMain}>
        <Badge tone={STATUS_TONE[task.status]} icon={STATUS_ICON[task.status]}>
          {STATUS_LABEL[task.status]}
        </Badge>
        <div className={styles.rowText}>
          <p className={styles.goal} title={task.goal}>
            {task.goal}
          </p>
          {task.detail && (
            <p className={styles.detail} title={task.detail}>
              {task.detail}
            </p>
          )}
        </div>
        <div className={styles.rowActions}>
          {canMessage && (
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setMessageOpen((open) => !open)}
              aria-label="Send a message to this task"
              title="Send a message to this task"
            >
              <Send size={14} />
            </button>
          )}
          {!isTerminal && (
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => onCancel(task.id)}
              aria-label="Cancel task"
              title="Cancel task"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {messageOpen && canMessage && (
        <div className={styles.messageRow}>
          <input
            type="text"
            className={styles.messageInput}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Say something to this task…"
            aria-label="Message text"
          />
          <Button variant="secondary" onClick={() => submit(onSteer)}>
            Steer
          </Button>
          <Button variant="primary" onClick={() => submit(onFollowUp)}>
            Follow up
          </Button>
        </div>
      )}
    </li>
  );
}
