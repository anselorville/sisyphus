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
  /** Whether the mic is currently open (voice input flowing). */
  micOpen?: boolean;
  /** Toggle the mic open/closed. */
  onToggleMic?: () => void;
}

const CONNECT_LABEL: Record<ConnectionState, string> = {
  disconnected: "Tap to start",
  connecting: "Connecting…",
  connected: "Listening",
  error: "Tap to retry",
};

/**
 * The single primary interactive object for the conversation screen: a large
 * circular talk control. In auto mode it fuses connect button and level
 * meter (original behavior). In manual turn mode it is the push-to-talk
 * control: tap to open the mic (speak), tap again to close it and trigger
 * translation -- while disconnected it still connects first, so the
 * one-button flow keeps working even if the user ignores the header switch.
 */
export function TalkButton({
  connectionState,
  level,
  onConnect,
  micOpen = false,
  onToggleMic,
}: TalkButtonProps) {
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";
  const clampedLevel = Math.min(1, Math.max(0, level));

  // Visual state once connected is driven by the mic, in both turn modes:
  // "ready" (mic closed) vs "connected" (mic open). The connection state
  // itself lives in the header switch, so the talk button's own state is
  // always "what will tapping do to the mic".
  const visualState = isConnected && !micOpen ? "ready" : connectionState;

  const label = (() => {
    if (!isConnected) return CONNECT_LABEL[connectionState];
    return micOpen ? "Tap to mute" : "Tap to talk";
  })();

  const handleClick = (() => {
    if (!isConnected) return onConnect;
    return onToggleMic ?? (() => {});
  })();

  const icon = (() => {
    if (isConnecting) return <Spinner size={26} aria-label="Connecting" />;
    if (connectionState === "error") return <AlertTriangle size={26} strokeWidth={2} />;
    return isConnected && !micOpen ? <MicOff size={26} strokeWidth={2} /> : <Mic size={26} strokeWidth={2} />;
  })();

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        data-state={visualState}
        style={{ "--ds-talk-level": clampedLevel } as TalkButtonStyle}
        onClick={handleClick}
        disabled={isConnecting}
        aria-pressed={isConnected && micOpen}
        aria-label={label}
      >
        <span className={styles.glow} aria-hidden="true" />
        <span className={styles.ring} aria-hidden="true" />
        <span className={styles.icon}>{icon}</span>
      </button>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
