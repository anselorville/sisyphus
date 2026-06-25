import type { ReactNode } from "react";
import { ArrowLeftRight, Settings } from "lucide-react";
import { Button } from "../../primitives/Button";
import type { LanguageOption } from "../../../data/languages";
import styles from "./LanguagePairHeader.module.css";

export interface LanguagePairHeaderProps {
  source: LanguageOption;
  target: LanguageOption;
  onSwap: () => void;
  onSettingsClick: () => void;
  statusSlot?: ReactNode;
}

function LanguagePill({ language }: { language: LanguageOption }) {
  return (
    <span className={styles.pill}>
      <span className={styles.code}>{language.code}</span>
      <span className={styles.name}>{language.nativeLabel}</span>
    </span>
  );
}

/**
 * Replaces the generic app title bar: shows the active source/target
 * language pair front and center with a swap affordance, plus a calm slot
 * for connection/engine status and the settings entry point.
 */
export function LanguagePairHeader({
  source,
  target,
  onSwap,
  onSettingsClick,
  statusSlot,
}: LanguagePairHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.pairRow}>
        <LanguagePill language={source} />
        <button
          type="button"
          className={styles.swapButton}
          onClick={onSwap}
          aria-label={`Swap to ${target.label} to ${source.label}`}
        >
          <ArrowLeftRight size={16} />
        </button>
        <LanguagePill language={target} />
      </div>
      <div className={styles.actions}>
        {statusSlot}
        <Button variant="ghost" onClick={onSettingsClick} aria-label="Open settings">
          <Settings size={18} />
        </Button>
      </div>
    </header>
  );
}
