import type { CSSProperties } from "react";
import { Mic, MicOff, AlertTriangle } from "lucide-react";
import { Spinner } from "../../primitives/Spinner";
import type { ConnectionState } from "../../../hooks/useTranslatorConnection.types";
import styles from "./TalkButton.module.css";

interface TalkButtonStyle extends CSSProperties {
  "--ds-talk-level"?: number;
}

export interface TalkButtonProps {
  connectionState: ConnectionState;
  /** Mic input level, 0-1. Drives the reactive glow ring while connected. */
  level: number;
  onConnect: () => void;
  onDisconnect: () => void;
}

const LABEL: Record<ConnectionState, string> = {
  disconnected: "Tap to start",
  connecting: "Connecting…",
  connected: "Listening",
  error: "Tap to retry",
};

function Icon({ connectionState }: { connectionState: ConnectionState }) {
  switch (connectionState) {
    case "connecting":
      return <Spinner size={32} aria-label="Connecting" />;
    case "connected":
      return <Mic size={32} strokeWidth={2} />;
    case "error":
      return <AlertTriangle size={32} strokeWidth={2} />;
    default:
      return <MicOff size={32} strokeWidth={2} />;
  }
}

/**
 * The single primary interactive object for the conversation screen: a large
 * circular talk control that fuses what used to be a separate connect button
 * and audio level meter. While connected, a glow ring reacts to live mic
 * level (driven by an inline CSS variable so we don't thrash class names on
 * every animation frame).
 */
export function TalkButton({ connectionState, level, onConnect, onDisconnect }: TalkButtonProps) {
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";
  const clampedLevel = Math.min(1, Math.max(0, level));

  const handleClick = isConnected ? onDisconnect : onConnect;

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        data-state={connectionState}
        style={{ "--ds-talk-level": clampedLevel } as TalkButtonStyle}
        onClick={handleClick}
        disabled={isConnecting}
        aria-pressed={isConnected}
        aria-label={LABEL[connectionState]}
      >
        <span className={styles.glow} aria-hidden="true" />
        <span className={styles.ring} aria-hidden="true" />
        <span className={styles.icon}>
          <Icon connectionState={connectionState} />
        </span>
      </button>
      <span className={styles.label}>{LABEL[connectionState]}</span>
    </div>
  );
}
