import { X } from "lucide-react";
import { Button } from "../../primitives/Button";
import { ServerAddressInput } from "../ServerAddressInput";
import type { ConnectionState } from "../../../hooks/useTranslatorConnection.types";
import styles from "./SettingsPanel.module.css";

export interface SettingsPanelProps {
  serverAddress: string;
  onServerAddressChange: (value: string) => void;
  connectionState: ConnectionState;
  onClose: () => void;
}

export function SettingsPanel({
  serverAddress,
  onServerAddressChange,
  connectionState,
  onClose,
}: SettingsPanelProps) {
  const isLocked = connectionState === "connected" || connectionState === "connecting";

  return (
    <div className={styles.panel} role="dialog" aria-label="Settings">
      <div className={styles.header}>
        <h2 className={styles.title}>Settings</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close settings">
          <X size={18} />
        </Button>
      </div>
      <ServerAddressInput value={serverAddress} onChange={onServerAddressChange} disabled={isLocked} />
    </div>
  );
}
