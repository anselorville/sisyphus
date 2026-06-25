import type { ReactNode } from "react";
import { Languages, Loader2, AlertTriangle } from "lucide-react";
import styles from "./EmptyState.module.css";

export type EmptyStateVariant = "welcome" | "connecting" | "error";

export interface EmptyStateProps {
  variant: EmptyStateVariant;
  /** Optional override, e.g. surface the actual fetch error in dev. */
  detail?: string;
  action?: ReactNode;
}

const ICON: Record<EmptyStateVariant, ReactNode> = {
  welcome: <Languages size={36} strokeWidth={1.5} />,
  connecting: <Loader2 size={36} strokeWidth={1.5} className={styles.spin} />,
  error: <AlertTriangle size={36} strokeWidth={1.5} />,
};

const TITLE: Record<EmptyStateVariant, string> = {
  welcome: "Ready when you are",
  connecting: "Connecting…",
  error: "Couldn't connect",
};

const BODY: Record<EmptyStateVariant, string> = {
  welcome: "Tap the mic below to start a conversation. Speak naturally -- translations appear here as you talk.",
  connecting: "Setting up your microphone and reaching the translator. This only takes a moment.",
  error: "Check that the server address is correct and reachable, then try again.",
};

/**
 * Welcoming first-screen / connecting / error states shown in place of the
 * transcript log before there's anything to show. Calm, non-alarming even
 * for the error variant -- uses the danger token sparingly (icon/title only).
 */
export function EmptyState({ variant, detail, action }: EmptyStateProps) {
  return (
    <div className={styles.empty} data-variant={variant} role={variant === "error" ? "alert" : "status"}>
      <span className={styles.icon}>{ICON[variant]}</span>
      <p className={styles.title}>{TITLE[variant]}</p>
      <p className={styles.body}>{detail ?? BODY[variant]}</p>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
