import styles from "./AudioLevelMeter.module.css";

export interface AudioLevelMeterProps {
  level: number;
}

const BAR_COUNT = 5;
const BAR_THRESHOLDS = [0.05, 0.2, 0.4, 0.6, 0.8];

export function AudioLevelMeter({ level }: AudioLevelMeterProps) {
  const clamped = Math.min(1, Math.max(0, level));

  return (
    <div className={styles.meter} role="img" aria-label={`Microphone level ${Math.round(clamped * 100)}%`}>
      {Array.from({ length: BAR_COUNT }, (_, i) => {
        const active = clamped >= BAR_THRESHOLDS[i];
        const scale = active ? Math.min(1, 0.35 + (clamped - BAR_THRESHOLDS[i]) * 1.6) : 0.18;
        return (
          <span
            key={i}
            className={styles.bar}
            data-active={active}
            style={{ transform: `scaleY(${scale})`, transitionDelay: `${i * 30}ms` }}
          />
        );
      })}
    </div>
  );
}
