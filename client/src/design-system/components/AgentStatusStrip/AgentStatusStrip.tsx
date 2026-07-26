import type { ReactNode } from "react";
import { Activity, Loader2, Mic, Moon, Volume2 } from "lucide-react";
import { Badge, type BadgeTone } from "../../primitives/Badge";
import { ConnectionStatusBadge } from "../ConnectionStatusBadge";
import type { ConnectionState } from "../../../hooks/useAgentConnection";
import type { FoodBand } from "../../../hooks/useEcologyStatus";
import styles from "./AgentStatusStrip.module.css";

/**
 * What the agent is doing right now, at a glance. Priority when deriving
 * this from raw state (see App.tsx): "hibernating" is a hard system-wide
 * override (the swarm has stopped thinking, nothing else matters more);
 * "speaking"/"listening" are momentary foreground turn-taking states, which
 * take priority over the persistent background "working" state (background
 * tasks can keep running while the user is mid-conversation); "idle" is the
 * fallback when nothing else applies.
 */
export type AgentActivityState = "idle" | "listening" | "speaking" | "working" | "hibernating";

export interface AgentStatusStripProps {
  connectionState: ConnectionState;
  activity: AgentActivityState;
  /**
   * Optional short human-readable detail, e.g. "2 tasks running". Kept to
   * one line (truncated with an ellipsis if it overflows) -- this strip's
   * own height never changes with text length, so it never pushes or
   * resizes the talk control below it.
   */
  detail?: string;
  ecologyBand: FoodBand;
}

const ACTIVITY_ICON: Record<AgentActivityState, ReactNode> = {
  idle: <Activity size={16} strokeWidth={2} />,
  listening: <Mic size={16} strokeWidth={2} />,
  speaking: <Volume2 size={16} strokeWidth={2} />,
  working: <Loader2 size={16} strokeWidth={2} className={styles.spin} />,
  hibernating: <Moon size={16} strokeWidth={2} />,
};

const ACTIVITY_LABEL: Record<AgentActivityState, string> = {
  idle: "Idle",
  listening: "Listening",
  speaking: "Speaking",
  working: "Working",
  hibernating: "Hibernating",
};

const ECOLOGY_TONE: Record<FoodBand, BadgeTone> = {
  prosperous: "secondary",
  conserving: "accent",
  reserve: "accent",
  hibernating: "danger",
  unknown: "neutral",
};

const ECOLOGY_LABEL: Record<FoodBand, string> = {
  prosperous: "Prosperous",
  conserving: "Conserving",
  reserve: "Reserve",
  hibernating: "Hibernating",
  unknown: "Unknown",
};

/**
 * Slim always-visible top strip: connection state, current listening /
 * speaking / working / hibernating activity, and a concise ecology chip
 * (see EcologyPanel for the fuller detail view). This is the "at a glance"
 * companion to EcologyPanel's fuller breakdown -- together they satisfy the
 * plan's "concise ecology status + food level" requirement.
 */
export function AgentStatusStrip({ connectionState, activity, detail, ecologyBand }: AgentStatusStripProps) {
  return (
    <div className={styles.strip} data-activity={activity}>
      <ConnectionStatusBadge connectionState={connectionState} />
      <span className={styles.activity}>
        <span className={styles.activityIcon}>{ACTIVITY_ICON[activity]}</span>
        <span className={styles.activityLabel}>{ACTIVITY_LABEL[activity]}</span>
        {detail && <span className={styles.detail}>{detail}</span>}
      </span>
      <span className={styles.spacer} />
      <Badge tone={ECOLOGY_TONE[ecologyBand]}>{ECOLOGY_LABEL[ecologyBand]}</Badge>
    </div>
  );
}
