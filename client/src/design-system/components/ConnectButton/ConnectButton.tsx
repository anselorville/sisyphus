import { Mic, MicOff } from "lucide-react";
import { Button } from "../../primitives/Button";
import type { ConnectionState } from "../../../hooks/useTranslatorConnection.types";

export interface ConnectButtonProps {
  connectionState: ConnectionState;
  onConnect: () => void;
  onDisconnect: () => void;
}

const LABEL: Record<ConnectionState, string> = {
  disconnected: "Connect",
  connecting: "Connecting…",
  connected: "Disconnect",
  error: "Retry",
};

export function ConnectButton({ connectionState, onConnect, onDisconnect }: ConnectButtonProps) {
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";

  return (
    <Button
      variant={isConnected ? "secondary" : "primary"}
      loading={isConnecting}
      icon={isConnected ? <MicOff size={18} /> : <Mic size={18} />}
      onClick={isConnected ? onDisconnect : onConnect}
      aria-pressed={isConnected}
    >
      {LABEL[connectionState]}
    </Button>
  );
}
