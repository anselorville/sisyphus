import { ConnectionStatusBadge } from "../../components/ConnectionStatusBadge";
import type { ConnectionState } from "../../../hooks/useTranslatorConnection.types";
import styles from "./WidgetShell.module.css";

export interface WidgetShellProps {
  connectionState: ConnectionState;
  latestTranslation?: string;
}

export function WidgetShell({ connectionState, latestTranslation }: WidgetShellProps) {
  return (
    <div className={styles.widget}>
      <ConnectionStatusBadge connectionState={connectionState} />
      <p className={styles.text}>
        {latestTranslation ?? (connectionState === "connected" ? "Listening…" : "Not connected")}
      </p>
    </div>
  );
}
