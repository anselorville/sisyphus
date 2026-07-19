import React, { useMemo, useRef, useState, useCallback } from "react";
import { X } from "lucide-react";
import { TalkButton } from "../TalkButton";
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
  /** Manual turn mode: each half gets its own mic button (same control,
   * same shared state -- one physical mic -- just reachable from either
   * seat). No power/connect control here: this screen is only ever reached
   * from the main screen, which already owns the service connection. */
  manualTurnMode: boolean;
  micOpen: boolean;
  onToggleMic: () => void;
  /** Live mic input level (0-1), for the mic buttons' reactive glow -- same signal the main screen's TalkButton uses. */
  micLevel?: number;
}

interface PanelItem {
  kind: "original" | "translation";
  text: string;
}

/**
 * Annotate every transcript event with the language its TEXT is in:
 * - a translation with direction "X->Y" is text in Y;
 * - an original (ASR) is text in X of the FIRST translation that follows it
 *   (originals precede their own translation in the stream);
 * - an original with no translation yet (utterance still being translated)
 *   has unknown language -- callers decide where to show it.
 */
function annotate(transcripts: TranscriptEvent[]): { lang: string | null; item: PanelItem }[] {
  return transcripts.map((event, i) => {
    if (event.kind === "translation") {
      const parsed = parseDirectionLanguages(event.direction);
      return { lang: parsed?.to?.toUpperCase() ?? null, item: { kind: "translation" as const, text: event.text } };
    }
    let lang: string | null = null;
    for (let j = i + 1; j < transcripts.length; j++) {
      const later = transcripts[j];
      if (later.kind === "translation") {
        lang = parseDirectionLanguages(later.direction)?.from?.toUpperCase() ?? null;
        break;
      }
    }
    return { lang, item: { kind: "original" as const, text: event.text } };
  });
}

/**
 * The latest content a reader of `language` should see: either something
 * they SAID (their own ASR original, shown as confirmation of what was
 * heard) or something said TO them (a translation into their language) --
 * whichever is most recent. `adoptUnresolved`: originals whose language
 * isn't known yet (translation still in flight) are shown on this panel,
 * so the person at the mic gets immediate "it heard me" feedback -- the
 * near/source panel opts in.
 */
function latestFor(
  annotated: { lang: string | null; item: PanelItem }[],
  language: LanguageOption,
  adoptUnresolved: boolean
): PanelItem | null {
  for (let i = annotated.length - 1; i >= 0; i--) {
    const { lang, item } = annotated[i];
    if (lang === language.code) return item;
    if (lang === null && item.kind === "original" && adoptUnresolved) return item;
  }
  return null;
}

// TalkButton requires connect/disconnect handlers, but the mic buttons
// rendered here are only ever shown when already connected AND in manual
// turn mode -- that combination always routes clicks through onToggleMic
// (see TalkButton's own handleClick), so these two branches are dead code
// in this context. No-ops, not omitted, so that stays true if TalkButton's
// internals ever change.
function noop() {}

function Half({
  language,
  item,
  rotated,
  connectionState,
  showMicButton,
  micOpen,
  onToggleMic,
  micLevel,
  style,
}: {
  language: LanguageOption;
  item: PanelItem | null;
  rotated: boolean;
  connectionState: ConnectionState;
  showMicButton: boolean;
  micOpen: boolean;
  onToggleMic: () => void;
  micLevel: number;
  style?: React.CSSProperties;
}) {
  return (
    <div className={styles.half} data-rotated={rotated || undefined} style={style}>
      <div className={styles.halfInner}>
        <div className={styles.halfHeader}>
          <span className={styles.langCode}>{language.code}</span>
          <span className={styles.langName}>{language.nativeLabel}</span>
        </div>
        <div className={styles.textWrap}>
          {item ? (
            <p className={styles.text} data-original={item.kind === "original" || undefined}>
              {item.text}
            </p>
          ) : (
            <p className={styles.placeholder}>
              {connectionState === "connected" ? "Waiting for speech…" : "Not connected"}
            </p>
          )}
        </div>
        {showMicButton && (
          <div className={styles.micRow}>
            <TalkButton
              connectionState={connectionState}
              level={micLevel}
              onConnect={noop}
              onDisconnect={noop}
              manualTurnMode
              micOpen={micOpen}
              onToggleMic={onToggleMic}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Face-to-face / "lay the device flat on the table" conversation mode.
 * The bottom half is upright for the person holding the device, the top
 * half is rotated 180 degrees for the person across the table. Each half
 * shows the latest content IN THAT PANEL'S LANGUAGE: your own side echoes
 * what the ASR heard you say (originals), and the far side shows the
 * translation addressed to that reader -- and vice versa when they speak.
 *
 * Each half has its OWN mic button (the exact TalkButton used on the main
 * screen), placed at that half's outer edge so whoever is sitting on that
 * side can reach it without leaning across the table. Both buttons drive
 * the SAME shared mic state -- there is one physical microphone -- so
 * either person can open/close the turn from their own seat.
 */
export function FaceToFaceView({
  source,
  target,
  transcripts,
  connectionState,
  onExit,
  manualTurnMode,
  micOpen,
  onToggleMic,
  micLevel = 0,
}: FaceToFaceViewProps) {
  const annotated = useMemo(() => annotate(transcripts), [transcripts]);
  // Near (bottom, upright) panel adopts not-yet-translated originals: the
  // mic is physically on this side, so "it heard me" feedback belongs here.
  const sourceItem = useMemo(() => latestFor(annotated, source, true), [annotated, source]);
  const targetItem = useMemo(() => latestFor(annotated, target, false), [annotated, target]);

  const showMicButtons = manualTurnMode && connectionState === "connected";

  const rootRef = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const ratio = Math.max(0.2, Math.min(0.8, y / rect.height));
    setSplitRatio(ratio);
  }, []);

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return (
    <div className={styles.root} ref={rootRef}>
      <Half
        language={target}
        item={targetItem}
        rotated
        connectionState={connectionState}
        showMicButton={showMicButtons}
        micOpen={micOpen}
        onToggleMic={onToggleMic}
        micLevel={micLevel}
        style={{ flex: splitRatio }}
      />
      <div
        className={styles.bar}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div className={styles.handle} />
        <button type="button" className={styles.exitButton} onClick={onExit} aria-label="Exit face-to-face mode">
          <X size={16} />
        </button>
        <div className={styles.handle} />
      </div>
      <Half
        language={source}
        item={sourceItem}
        rotated={false}
        connectionState={connectionState}
        showMicButton={showMicButtons}
        micOpen={micOpen}
        onToggleMic={onToggleMic}
        micLevel={micLevel}
        style={{ flex: 1 - splitRatio }}
      />
    </div>
  );
}
