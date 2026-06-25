import { useEffect, useRef } from "react";
import { TranscriptEntry } from "../TranscriptEntry";
import { EmptyState, type EmptyStateVariant } from "../EmptyState";
import type { TranscriptEvent } from "../../../hooks/useTranslatorConnection.types";
import styles from "./TranscriptLog.module.css";

export interface TranscriptLogProps {
  entries: TranscriptEvent[];
  /** Empty-state variant to show when there are no entries yet. Defaults to "welcome". */
  emptyVariant?: EmptyStateVariant;
  emptyDetail?: string;
}

export function TranscriptLog({ entries, emptyVariant = "welcome", emptyDetail }: TranscriptLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (entries.length === 0) {
    return <EmptyState variant={emptyVariant} detail={emptyDetail} />;
  }

  return (
    <div className={styles.log} ref={scrollRef}>
      {entries.map((entry) => (
        <TranscriptEntry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
