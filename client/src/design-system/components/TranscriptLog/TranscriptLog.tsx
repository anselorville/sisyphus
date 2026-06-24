import { useEffect, useRef } from "react";
import { MessageSquareText } from "lucide-react";
import { TranscriptEntry } from "../TranscriptEntry";
import type { TranscriptEvent } from "../../../hooks/useTranslatorConnection.types";
import styles from "./TranscriptLog.module.css";

export interface TranscriptLogProps {
  entries: TranscriptEvent[];
}

export function TranscriptLog({ entries }: TranscriptLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className={styles.empty}>
        <MessageSquareText size={28} strokeWidth={1.5} />
        <p>Connect and start speaking to see the transcript here.</p>
      </div>
    );
  }

  return (
    <div className={styles.log} ref={scrollRef}>
      {entries.map((entry) => (
        <TranscriptEntry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
