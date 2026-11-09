import { useEffect, useRef, useState } from "react";
import styles from "./TranscriptPanel.module.css";

export interface TranscriptEntry {
  readonly id: number;
  readonly speaker: "user" | "agent";
  readonly text: string;
  readonly timestamp: number;
}

export interface TranscriptPanelProps {
  entries: readonly TranscriptEntry[];
  /** Interim text of the user's current turn; shown faded after the entries until the final arrives. */
  pendingUserText?: string;
}

/**
 * Real-time subtitle stream: user STT transcripts (input) and agent speech
 * (output) appended as they happen, auto-scrolled to the newest entry.
 */
export function TranscriptPanel({ entries, pendingUserText }: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, pendingUserText, autoScroll]);

  return (
    <section className={styles.panel} aria-label="实时字幕">
      <div className={styles.header}>
        <span>实时字幕</span>
        <button
          type="button"
          className={styles.autoToggle}
          onClick={() => setAutoScroll((v) => !v)}
        >
          {autoScroll ? "自动滚动" : "已暂停"}
        </button>
      </div>
      <div
        ref={scrollRef}
        className={styles.stream}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== autoScroll) setAutoScroll(atBottom);
        }}
      >
        {entries.length === 0 && !pendingUserText && <div className={styles.empty}>说话后，这里会显示双向字幕</div>}
        {entries.map((entry) => (
          <div key={entry.id} className={`${styles.entry} ${entry.speaker === "user" ? styles.user : styles.agent}`}>
            <span className={styles.speaker}>{entry.speaker === "user" ? "你" : "Agent"}</span>
            <span className={styles.text}>{entry.text}</span>
          </div>
        ))}
        {pendingUserText && (
          <div className={`${styles.entry} ${styles.user} ${styles.pending}`} aria-live="polite">
            <span className={styles.speaker}>你</span>
            <span className={styles.text}>{pendingUserText}</span>
          </div>
        )}
      </div>
    </section>
  );
}
