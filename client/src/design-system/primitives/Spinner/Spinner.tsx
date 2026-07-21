import styles from "./Spinner.module.css";

export interface SpinnerProps {
  size?: number;
  "aria-label"?: string;
}

export function Spinner({ size = 16, "aria-label": ariaLabel = "Loading" }: SpinnerProps) {
  return (
    <span
      className={styles.spinner}
      role="status"
      aria-label={ariaLabel}
      style={{ width: size, height: size }}
    />
  );
}
