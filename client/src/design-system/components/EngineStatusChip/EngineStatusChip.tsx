import type { ReactElement } from "react";
import { Cloud, HardDrive, Laptop, HelpCircle } from "lucide-react";
import { Badge, type BadgeTone } from "../../primitives/Badge";

/**
 * Which translation engine/backend is currently active. This is UI-only
 * scaffolding: the Python backend does not yet expose an endpoint reporting
 * which of these is live (cloud APIs vs. the offline Pi-portable fallback
 * vs. a Mac-dev-only local oMLX path). Until that exists this prop should be
 * fed a static/guessed value or omitted ("unknown").
 */
export type EngineMode = "cloud" | "offline" | "local-dev" | "unknown";

export interface EngineStatusChipProps {
  mode: EngineMode;
}

const TONE: Record<EngineMode, BadgeTone> = {
  cloud: "secondary",
  offline: "accent",
  "local-dev": "primary",
  unknown: "neutral",
};

const LABEL: Record<EngineMode, string> = {
  cloud: "Engine: Cloud",
  offline: "Engine: Offline",
  "local-dev": "Engine: Local (dev)",
  unknown: "Engine: Unknown",
};

const ICON: Record<EngineMode, ReactElement> = {
  cloud: <Cloud size={14} />,
  offline: <HardDrive size={14} />,
  "local-dev": <Laptop size={14} />,
  unknown: <HelpCircle size={14} />,
};

/** Small, calm, non-alarming chip reflecting which translation engine is active. */
export function EngineStatusChip({ mode }: EngineStatusChipProps) {
  return (
    <Badge tone={TONE[mode]} icon={ICON[mode]}>
      {LABEL[mode]}
    </Badge>
  );
}
