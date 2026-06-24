import { DirectionChip } from "../DirectionChip";
import type { TranscriptEvent } from "../../../hooks/useTranslatorConnection.types";
import styles from "./TranscriptEntry.module.css";

export interface TranscriptEntryProps {
  entry: TranscriptEvent;
}

export function TranscriptEntry({ entry }: TranscriptEntryProps) {
  const isTranslation = entry.kind === "translation";

  return (
    <div className={styles.entry} data-kind={entry.kind}>
      <div className={styles.bar} />
      <div className={styles.body}>
        <div className={styles.header}>
          <span className={styles.label}>{isTranslation ? "Translated" : "Heard"}</span>
          {isTranslation && <DirectionChip direction={entry.direction} />}
        </div>
        <p className={styles.text}>{entry.text}</p>
      </div>
    </div>
  );
}
