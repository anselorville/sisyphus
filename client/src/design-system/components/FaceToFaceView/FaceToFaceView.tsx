import { useMemo } from "react";
import { Mic, MicOff, X } from "lucide-react";
import type { TranscriptEvent, ConnectionState } from "../../../hooks/useTranslatorConnection.types";
import type { LanguageOption } from "../../../data/languages";
import { parseDirectionLanguages } from "../../../data/languages";
import styles from "./FaceToFaceView.module.css";

export interface FaceToFaceViewProps {
  source: LanguageOption;
  target: LanguageOption;
  transcripts: TranscriptEvent[];
  connectionState: ConnectionState;
  onExit: () => void;
}

interface HalfContent {
  language: LanguageOption;
  text: string | null;
}

/**
 * Picks, for a given language, the most recent translation whose direction
 * tag ends in that language's code (i.e. "what this person should read").
 * Falls back to the single most recent translation if direction tags are
 * missing (older/degraded backend behavior), and finally to null.
 */
function latestTranslationFor(transcripts: TranscriptEvent[], language: LanguageOption): string | null {
  for (let i = transcripts.length - 1; i >= 0; i--) {
    const entry = transcripts[i];
    if (entry.kind !== "translation") continue;
    const parsed = parseDirectionLanguages(entry.direction);
    if (parsed && parsed.to.toUpperCase() === language.code) {
      return entry.text;
    }
  }
  // No direction-tagged match -- fall back to the latest translation overall
  // so at least one side shows something rather than nothing.
  const lastTranslation = [...transcripts].reverse().find((entry) => entry.kind === "translation");
  return lastTranslation?.text ?? null;
}

function Half({ content, rotated, connectionState }: { content: HalfContent; rotated: boolean; connectionState: ConnectionState }) {
  return (
    <div className={styles.half} data-rotated={rotated || undefined}>
      <div className={styles.halfInner}>
        <div className={styles.halfHeader}>
          <span className={styles.langCode}>{content.language.code}</span>
          <span className={styles.langName}>{content.language.nativeLabel}</span>
        </div>
        <div className={styles.textWrap}>
          {content.text ? (
            <p className={styles.text}>{content.text}</p>
          ) : (
            <p className={styles.placeholder}>
              {connectionState === "connected" ? "Waiting for speech…" : "Not connected"}
            </p>
          )}
        </div>
        <div className={styles.statusRow}>
          {connectionState === "connected" ? <Mic size={16} /> : <MicOff size={16} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Face-to-face / "lay the device flat on the table" conversation mode.
 * Splits the screen horizontally into two halves: the bottom half is
 * upright for the person holding/facing the device, the top half is
 * rotated 180 degrees so the person across the table sees their language
 * right-side-up from their seat. Each half shows the latest translation
 * addressed to that language, derived from the transcript's "XX->YY"
 * direction tags (see app/pipeline.py::parse_direction_prefix).
 */
export function FaceToFaceView({ source, target, transcripts, connectionState, onExit }: FaceToFaceViewProps) {
  const sourceText = useMemo(() => latestTranslationFor(transcripts, source), [transcripts, source]);
  const targetText = useMemo(() => latestTranslationFor(transcripts, target), [transcripts, target]);

  return (
    <div className={styles.root}>
      <Half
        content={{ language: target, text: targetText }}
        rotated
        connectionState={connectionState}
      />
      <button type="button" className={styles.exitButton} onClick={onExit} aria-label="Exit face-to-face mode">
        <X size={18} />
      </button>
      <div className={styles.divider} aria-hidden="true" />
      <Half
        content={{ language: source, text: sourceText }}
        rotated={false}
        connectionState={connectionState}
      />
    </div>
  );
}
