import type { ReactNode } from "react";
import { Leaf, Zap } from "lucide-react";
import type { FoodBand } from "../../../hooks/useEcologyStatus";
import styles from "./EcologyPanel.module.css";

export interface EcologyPanelProps {
  /** Compute/system health band -- agent-runtime's ecology.state.changed. */
  ecology: FoodBand;
  /** Budget (API spend / subscription quota) band -- agent-runtime's budget.updated. Never converted into a shared currency with `ecology` -- see agent-runtime/src/economy/types.ts's own doc comment on why the two stay independent. */
  food: FoodBand;
  /** Whether app/server.py currently holds a live connection to the agent-runtime sidecar at all -- if false, both bands are necessarily stale/unknown regardless of their literal value. */
  sidecarConnected: boolean;
}

const BAND_FILL: Record<FoodBand, number> = {
  prosperous: 4,
  conserving: 3,
  reserve: 2,
  hibernating: 1,
  unknown: 0,
};

const BAND_LABEL: Record<FoodBand, string> = {
  prosperous: "Prosperous",
  conserving: "Conserving",
  reserve: "Reserve",
  hibernating: "Hibernating",
  unknown: "Unknown",
};

const ECOLOGY_DESCRIPTION: Record<FoodBand, string> = {
  prosperous: "System resources are healthy.",
  conserving: "Conserving resources -- important tasks are prioritized.",
  reserve: "Resources are tight -- only important tasks proceed.",
  hibernating: "Hibernating -- basic conversation still works.",
  unknown: "Not yet reported by the agent runtime.",
};

const FOOD_DESCRIPTION: Record<FoodBand, string> = {
  prosperous: "Budget is healthy.",
  conserving: "Budget is tight -- reducing non-essential attempts.",
  reserve: "Budget in reserve -- only important tasks proceed.",
  hibernating: "Usage exhausted -- basic conversation still works.",
  unknown: "Not yet reported by the agent runtime.",
};

interface GaugeRowProps {
  icon: ReactNode;
  label: string;
  band: FoodBand;
  description: string;
}

function GaugeRow({ icon, label, band, description }: GaugeRowProps) {
  const fill = BAND_FILL[band];
  return (
    <div className={styles.row} data-band={band}>
      <div className={styles.rowHeader}>
        <span className={styles.rowIcon}>{icon}</span>
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowBand}>{BAND_LABEL[band]}</span>
      </div>
      <div className={styles.gauge} role="img" aria-label={`${label}: ${BAND_LABEL[band]}`}>
        {Array.from({ length: 4 }, (_, index) => (
          <span key={index} className={styles.segment} data-filled={index < fill} data-dashed={band === "unknown"} />
        ))}
      </div>
      <p className={styles.description}>{description}</p>
    </div>
  );
}

/**
 * Fuller ecology/budget detail card -- the companion to AgentStatusStrip's
 * single concise chip. Shows both independent bands (compute/system health
 * and API/subscription budget) with a short human-readable description per
 * band, mirroring (in English, for display rather than speech) the same
 * band vocabulary agent-runtime/src/voice/voice-herald.ts uses for its
 * spoken budget/ecology directives.
 */
export function EcologyPanel({ ecology, food, sidecarConnected }: EcologyPanelProps) {
  return (
    <section className={styles.panel} aria-label="Ecology and budget status">
      <h2 className={styles.heading}>Ecology</h2>
      {!sidecarConnected && (
        <p className={styles.notice}>Agent runtime not connected -- status below may be stale or unknown.</p>
      )}
      <GaugeRow icon={<Leaf size={16} />} label="System" band={ecology} description={ECOLOGY_DESCRIPTION[ecology]} />
      <GaugeRow icon={<Zap size={16} />} label="Budget" band={food} description={FOOD_DESCRIPTION[food]} />
    </section>
  );
}
