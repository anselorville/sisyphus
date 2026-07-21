import { Wifi, WifiOff, AlertTriangle } from "lucide-react";
import { Badge, type BadgeTone } from "../../primitives/Badge";
import { Spinner } from "../../primitives/Spinner";
import type { ConnectionState } from "../../../hooks/useTranslatorConnection.types";

export interface ConnectionStatusBadgeProps {
  connectionState: ConnectionState;
}

const TONE: Record<ConnectionState, BadgeTone> = {
  disconnected: "neutral",
  connecting: "accent",
  connected: "secondary",
  error: "danger",
};

const LABEL: Record<ConnectionState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Connection error",
};

function StateIcon({ connectionState }: { connectionState: ConnectionState }) {
  switch (connectionState) {
    case "connecting":
      return <Spinner size={14} />;
    case "connected":
      return <Wifi size={14} />;
    case "error":
      return <AlertTriangle size={14} />;
    default:
      return <WifiOff size={14} />;
  }
}

export function ConnectionStatusBadge({ connectionState }: ConnectionStatusBadgeProps) {
  return (
    <Badge tone={TONE[connectionState]} icon={<StateIcon connectionState={connectionState} />}>
      {LABEL[connectionState]}
    </Badge>
  );
}
