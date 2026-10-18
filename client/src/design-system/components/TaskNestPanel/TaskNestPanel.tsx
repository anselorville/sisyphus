import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleMinus, CirclePause, CirclePlay, Hourglass, ListTodo, Loader2 } from "lucide-react";
import type { AgentTask, AgentTaskStatus } from "../../../hooks/useAgentTasks";
import styles from "./TaskNestPanel.module.css";

export interface TaskNestPanelProps {
  tasks: readonly AgentTask[];
}

const ROTATE_INTERVAL_MS = 4000;
const VISIBLE_COUNT = 2; // 1.5 cards visible: one full card + half a card peek

const STATUS_TONE: Record<AgentTaskStatus, "pending" | "running" | "done" | "failed" | "neutral"> = {
  pending: "pending",
  assigned: "pending",
  running: "running",
  blocked: "pending",
  completed: "done",
  failed: "failed",
  cancelled: "neutral",
};

const STATUS_ICON: Record<AgentTaskStatus, ReactNode> = {
  pending: <Hourglass size={13} />,
  assigned: <Hourglass size={13} />,
  running: <Loader2 size={13} className={styles.spin} />,
  blocked: <Hourglass size={13} />,
  completed: <CircleCheck size={13} />,
  failed: <CircleAlert size={13} />,
  cancelled: <CircleMinus size={13} />,
};

const STATUS_LABEL: Record<AgentTaskStatus, string> = {
  pending: "进行中",
  assigned: "准备中",
  running: "处理中",
  blocked: "等待确认",
  completed: "已结束",
  failed: "需要重试",
  cancelled: "已取消",
};

export interface RotationPauseState {
  readonly hovered: boolean;
  readonly focused: boolean;
  readonly explicitlyPaused: boolean;
}

export function shouldPauseRotation(state: RotationPauseState): boolean {
  return state.hovered || state.focused || state.explicitlyPaused;
}

export function getPreferredWindowStart(tasks: readonly AgentTask[], requestedIndex: number): number {
  const maxIndex = Math.max(0, tasks.length - VISIBLE_COUNT);
  const activeIndex = tasks.findIndex((task) => task.status === "pending" || task.status === "running");
  const preferredIndex = activeIndex === -1 ? requestedIndex : activeIndex - (VISIBLE_COUNT - 1);
  return Math.min(Math.max(0, preferredIndex), maxIndex);
}

export function getVisibleTaskIndexes(tasks: readonly AgentTask[], companionOffset: number): readonly number[] {
  if (tasks.length <= VISIBLE_COUNT) return tasks.map((_, taskIndex) => taskIndex);

  const activeIndex = tasks.findIndex((task) => task.status === "pending" || task.status === "running");
  if (activeIndex === -1) {
    const start = getPreferredWindowStart(tasks, companionOffset);
    return [start, start + 1];
  }

  const companions = tasks.flatMap((_, taskIndex) => (taskIndex === activeIndex ? [] : [taskIndex]));
  const companionIndex = companions[companionOffset % companions.length];
  return companionIndex === undefined ? [activeIndex] : [activeIndex, companionIndex];
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}

/**
 * Scribe topics as a cylinder ("滚筒"): a compact vertical carousel showing 1.5
 * cards at once with no scrollbar. The visible window auto-rotates through
 * the ledger every few seconds (paused on hover), so the whole session's
 * task list is discoverable in a small fixed-height strip and the remaining
 * screen height goes to the live transcript. Display-only: the ledger is
 * produced by the Scribe agent, not by user interaction here.
 */
export function TaskNestPanel({ tasks }: TaskNestPanelProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [explicitlyPaused, setExplicitlyPaused] = useState(false);
  const count = tasks.length;
  const paused = shouldPauseRotation({ hovered, focused, explicitlyPaused });

  useEffect(() => {
    if (count <= VISIBLE_COUNT || prefersReducedMotion || paused) return;
    const timer = setInterval(() => {
      if (!paused) {
        setIndex((i) => (i + 1) % Math.max(1, count - 1));
      }
    }, ROTATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [count, paused, prefersReducedMotion]);

  useEffect(() => {
    setIndex(0);
  }, [tasks]);

  if (count === 0) {
    return (
      <section className={styles.panel} aria-label="会话话题">
        <h2 className={styles.heading}>
          <ListTodo size={14} />
          <span className={styles.headingCopy}>
            <span className={styles.headingTitle}>会话话题</span>
            <span className={styles.headingHint}>书记员按顺序整理</span>
          </span>
        </h2>
        <p className={styles.empty}>等待书记员整理本次会话…</p>
      </section>
    );
  }

  const visible = getVisibleTaskIndexes(tasks, index).flatMap((taskIndex, visibleIndex) => {
    const task = tasks[taskIndex];
    return task === undefined ? [] : [{ task, isPeek: visibleIndex === 1 }];
  });

  return (
    <section
      className={styles.panel}
      aria-label="会话话题"
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <h2 className={styles.heading}>
        <ListTodo size={14} />
        <span className={styles.headingCopy}>
          <span className={styles.headingTitle}>会话话题</span>
          <span className={styles.headingHint}>书记员按顺序整理</span>
        </span>
        <span className={styles.count}>{count}</span>
        {count > VISIBLE_COUNT && !prefersReducedMotion && (
          <button
            className={styles.pauseButton}
            type="button"
            aria-label={explicitlyPaused ? "恢复话题轮播" : "暂停话题轮播"}
            aria-pressed={explicitlyPaused}
            onClick={() => {
              setExplicitlyPaused((value) => !value);
            }}
          >
            {explicitlyPaused ? <CirclePlay size={13} /> : <CirclePause size={13} />}
          </button>
        )}
      </h2>

      <div className={styles.cylinder}>
        {visible.map(({ task, isPeek }) => {
          const phrase = task.topicPhrase ?? task.goal;
          const summary = task.topicSummary ?? task.detail;
          return (
            <article
              key={task.id}
              className={`${styles.card} ${styles[STATUS_TONE[task.status]]}`}
              data-peek={isPeek && visible.length > 1}
              aria-label={`${phrase}，${STATUS_LABEL[task.status]}`}
            >
              <span className={styles.cardIcon}>{STATUS_ICON[task.status]}</span>
              <div className={styles.cardBody}>
                <span className={styles.cardTitle} title={task.goal}>
                  {phrase}
                </span>
                {summary && <span className={styles.cardSummary}>{summary}</span>}
              </div>
              <span className={styles.stateLabel}>{STATUS_LABEL[task.status]}</span>
            </article>
          );
        })}
      </div>
    </section>
  );
}
