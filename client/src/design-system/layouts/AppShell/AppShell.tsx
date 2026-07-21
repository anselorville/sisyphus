import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { Button } from "../../primitives/Button";
import { ConnectionStatusBadge } from "../../components/ConnectionStatusBadge";
import type { ConnectionState } from "../../../hooks/useTranslatorConnection.types";
import styles from "./AppShell.module.css";

export interface AppShellProps {
  title: string;
  connectionState: ConnectionState;
  onSettingsClick: () => void;
  children: ReactNode;
  footer: ReactNode;
}

export function AppShell({ title, connectionState, onSettingsClick, children, footer }: AppShellProps) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        <div className={styles.headerActions}>
          <ConnectionStatusBadge connectionState={connectionState} />
          <Button variant="ghost" onClick={onSettingsClick} aria-label="Open settings">
            <Settings size={18} />
          </Button>
        </div>
      </header>
      <main className={styles.content}>{children}</main>
      <footer className={styles.footer}>{footer}</footer>
    </div>
  );
}
