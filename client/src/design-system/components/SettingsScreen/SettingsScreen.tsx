import { ArrowLeft, ChevronDown, FlaskConical, Server } from "lucide-react";
import { Button } from "../../primitives/Button";
import { LanguagePicker } from "../LanguagePicker";
import { ServerAddressInput } from "../ServerAddressInput";
import { EngineStatusChip, type EngineMode } from "../EngineStatusChip";
import type { LanguageOption } from "../../../data/languages";
import type { ConnectionState } from "../../../hooks/useTranslatorConnection.types";
import styles from "./SettingsScreen.module.css";

export interface SettingsScreenProps {
  source: LanguageOption;
  target: LanguageOption;
  onSourceChange: (language: LanguageOption) => void;
  onTargetChange: (language: LanguageOption) => void;
  serverAddress: string;
  onServerAddressChange: (value: string) => void;
  connectionState: ConnectionState;
  engineMode: EngineMode;
  onClose: () => void;
  onOpenModelLab: () => void;
  onOpenModelProvider: () => void;
}

/**
 * Screen-level settings experience (replaces the old small overlay panel).
 * Language pair selection is the primary, most prominent control; engine
 * mode is a read-only status display for now (see EngineStatusChip --
 * real wiring is pending a backend endpoint); server address is tucked
 * into a collapsed "Developer" section since it's a dev/debug affordance,
 * not a primary user-facing setting.
 */
export function SettingsScreen({
  source,
  target,
  onSourceChange,
  onTargetChange,
  serverAddress,
  onServerAddressChange,
  connectionState,
  engineMode,
  onClose,
  onOpenModelLab,
  onOpenModelProvider,
}: SettingsScreenProps) {
  const isLocked = connectionState === "connected" || connectionState === "connecting";

  return (
    <div className={styles.screen} role="dialog" aria-label="Settings">
      <header className={styles.header}>
        <Button variant="ghost" onClick={onClose} aria-label="Back to conversation">
          <ArrowLeft size={18} />
        </Button>
        <h1 className={styles.title}>Settings</h1>
      </header>

      <div className={styles.content}>
        <section className={styles.group}>
          <h2 className={styles.groupTitle}>Conversation</h2>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Language pair</h3>
            <p className={styles.sectionHint}>
              Translation runs both directions automatically -- pick the two languages in this conversation.
            </p>
            <div className={styles.pickerStack}>
              <LanguagePicker
                label="Your language"
                value={source}
                onChange={onSourceChange}
                disabledCodes={[target.code]}
              />
              <LanguagePicker
                label="Their language"
                value={target}
                onChange={onTargetChange}
                disabledCodes={[source.code]}
              />
            </div>
          </section>
        </section>

        <section className={styles.group}>
          <h2 className={styles.groupTitle}>Infrastructure</h2>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Engine status</h3>
            <p className={styles.sectionHint}>
              Shows which backend is currently translating. Cloud, offline (Pi-portable), and local
              (Mac dev) modes are all supported -- this reflects whichever the server is running.
            </p>
            <EngineStatusChip mode={engineMode} />
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Model Tuning</h3>
            <p className={styles.sectionHint}>
              Tune the ASR, LLM, and TTS models directly -- including the LLM's persona, since that's what decides
              whether this product stays a translator or becomes something else entirely.
            </p>
            <Button variant="secondary" icon={<FlaskConical size={18} />} onClick={onOpenModelLab}>
              Open Model Lab
            </Button>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Model Provider</h3>
            <p className={styles.sectionHint}>
              Choose which provider and model serve text, voice, listening, and (soon) omni capabilities -- and switch
              between running fully local or in the cloud.
            </p>
            <Button variant="secondary" icon={<Server size={18} />} onClick={onOpenModelProvider}>
              Open Model Provider
            </Button>
          </section>
        </section>

        <details className={styles.devSection}>
          <summary className={styles.devSummary}>
            <ChevronDown size={16} className={styles.devChevron} />
            Developer options
          </summary>
          <div className={styles.devContent}>
            <ServerAddressInput value={serverAddress} onChange={onServerAddressChange} disabled={isLocked} />
          </div>
        </details>
      </div>
    </div>
  );
}
