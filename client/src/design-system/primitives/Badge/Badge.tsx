import type { ReactNode } from "react";
import styles from "./Badge.module.css";

export type BadgeTone = "primary" | "secondary" | "accent" | "danger" | "neutral";

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
}

export function Badge({ tone = "neutral", icon, children }: BadgeProps) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {icon && <span className={styles.icon}>{icon}</span>}
      {children}
    </span>
  );
}
