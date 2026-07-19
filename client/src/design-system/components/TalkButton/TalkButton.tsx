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
  /**
   * Manual turn mode (the default noisy-environment UX): once connected,
   * this button gates VOICE INPUT (open mic = start a turn, close mic =
   * "I'm done, translate now") instead of toggling the connection -- the
   * connection itself is owned by the service switch in the header. When
   * false (auto/hands-free mode), the button keeps its original
   * connect/disconnect behavior.
   */
  manualTurnMode?: boolean;
  /** Manual turn mode: whether the mic is currently open. */
  micOpen?: boolean;
  /** Manual turn mode: toggle the mic open/closed. */
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
  onDisconnect,
  manualTurnMode = false,
  micOpen = false,
  onToggleMic,
}: TalkButtonProps) {
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";
  const clampedLevel = Math.min(1, Math.max(0, level));

  // Visual state: manual mode adds "ready" (connected, mic closed --
  // service is up but nothing is listening) on top of the original four.
  const visualState = manualTurnMode && isConnected && !micOpen ? "ready" : connectionState;

  const label = (() => {
    if (!manualTurnMode || !isConnected) return CONNECT_LABEL[connectionState];
    return micOpen ? "Tap when done" : "Tap to talk";
  })();

  const handleClick = (() => {
    if (manualTurnMode) {
      if (isConnected) return onToggleMic ?? (() => {});
      return onConnect; // not connected yet: first tap still brings the service up
    }
    return isConnected ? onDisconnect : onConnect;
  })();

  const icon = (() => {
    if (isConnecting) return <Spinner size={32} aria-label="Connecting" />;
    if (connectionState === "error") return <AlertTriangle size={32} strokeWidth={2} />;
    if (manualTurnMode && isConnected) {
      return micOpen ? <Mic size={32} strokeWidth={2} /> : <MicOff size={32} strokeWidth={2} />;
    }
    return isConnected ? <Mic size={32} strokeWidth={2} /> : <MicOff size={32} strokeWidth={2} />;
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
        aria-pressed={manualTurnMode ? micOpen : isConnected}
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
