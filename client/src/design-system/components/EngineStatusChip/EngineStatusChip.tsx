import type { ReactElement } from "react";
import { Cloud, HardDrive, Laptop, HelpCircle } from "lucide-react";
import { Badge, type BadgeTone } from "../../primitives/Badge";

/**
 * Which translation engine/backend is currently active (cloud APIs vs. the
 * offline Pi-portable fallback vs. a Mac-dev-only local oMLX path). Sourced
 * from the backend's `GET /api/status` endpoint (see app/server.py and
 * `useTranslatorConnection`'s `serverStatus`) -- "unknown" is used while
 * that fetch is pending or if it fails.
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
