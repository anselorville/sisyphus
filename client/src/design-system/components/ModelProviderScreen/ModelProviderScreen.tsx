import { useEffect, useState } from "react";
import { ArrowLeft, Cloud, HardDrive, MessageSquare, Mic, Sparkles, Volume2 } from "lucide-react";
import { Button } from "../../primitives/Button";
import { Badge } from "../../primitives/Badge";
import { useModelProviders } from "../../../hooks/useModelProviders";
import { LocalModelsControl } from "../LocalModelsControl";
import type {
  ModelCapability,
  ModelProviderCloudConfig,
  ModelProviderMode,
} from "../../../hooks/useTranslatorConnection.types";
import styles from "./ModelProviderScreen.module.css";

export interface ModelProviderScreenProps {
  serverAddress: string;
  onClose: () => void;
}

const MODE_TABS: { key: ModelProviderMode; label: string; icon: typeof HardDrive }[] = [
  { key: "local", label: "Local", icon: HardDrive },
  { key: "cloud", label: "Cloud", icon: Cloud },
];

const CAPABILITY_ROWS: { key: ModelCapability; label: string; icon: typeof MessageSquare }[] = [
  { key: "text", label: "Text", icon: MessageSquare },
  { key: "speech", label: "Voice", icon: Volume2 },
  { key: "transcription", label: "Listening", icon: Mic },
  { key: "omni", label: "Omni", icon: Sparkles },
];

type DraftCloud = ModelProviderCloudConfig;

const ALL_CAPABILITIES: ModelCapability[] = ["text", "speech", "transcription", "omni"];

function cloudCapabilitiesEqual(a: DraftCloud, b: DraftCloud): boolean {
  return ALL_CAPABILITIES.every((key) => a[key].provider === b[key].provider && a[key].model === b[key].model);
}

/**
 * "Model Provider" -- the infrastructure-capability layer: which
 * provider/model actually serves each of the 4 model-capability types
 * (text/speech/transcription/omni), for either a Local or Cloud mode. This
 * is distinct from Model Lab (tuning/debug parameters like temperature and
 * persona) and Settings (business-level pipeline config like translation
 * direction) -- this screen answers "what serves the request," not "how is
 * it tuned" or "what does the product do with it."
 *
 * Reachable from SettingsScreen, same pattern as Model Lab. Mirrors Model
 * Lab's draft-then-explicit-save posture: every tab click and select change
 * only updates local draft state -- nothing is sent to the server until the
 * user clicks "Save changes," which fires a single combined PUT.
 */
export function ModelProviderScreen({ serverAddress, onClose }: ModelProviderScreenProps) {
  const { data, loadError, updateError, update } = useModelProviders(serverAddress);

  const [draftMode, setDraftMode] = useState<ModelProviderMode | null>(null);
  const [draftCloud, setDraftCloud] = useState<DraftCloud | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed the draft from the loaded/saved data, but only when there's no
  // in-progress unsaved draft yet -- mirrors Model Lab's behavior of not
  // clobbering edits if the underlying data re-fetches in the background.
  useEffect(() => {
    if (!data) return;
    setDraftMode((prev) => prev ?? data.mode);
    setDraftCloud((prev) => prev ?? data.cloud);
  }, [data]);

  // Clear a transient "saved" confirmation after a few seconds so it doesn't
  // linger indefinitely as stale-looking UI.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);

  if (loadError) {
    return (
      <div className={styles.screen} role="dialog" aria-label="Model Provider">
        <Header onClose={onClose} />
        <div className={styles.content}>
          <p className={styles.errorText}>
            Couldn't reach the server to load model provider settings -- check the connection in Settings and try
            again.
          </p>
        </div>
      </div>
    );
  }

  if (!data || draftMode === null || draftCloud === null) {
    return (
      <div className={styles.screen} role="dialog" aria-label="Model Provider">
        <Header onClose={onClose} />
        <div className={styles.content}>
          <p className={styles.sectionHint}>Loading model provider settings...</p>
        </div>
      </div>
    );
  }

  const hasUnsavedChanges = draftMode !== data.mode || !cloudCapabilitiesEqual(draftCloud, data.cloud);

  function handleModeChange(mode: ModelProviderMode) {
    setDraftMode(mode);
  }

  function handleProviderChange(capability: ModelCapability, provider: string) {
    setDraftCloud((prev) => {
      if (!prev) return prev;
      const capabilityData = prev[capability];
      const models = capabilityData.available_models[provider] ?? [];
      const model = models[0] ?? null;
      return {
        ...prev,
        [capability]: { ...capabilityData, provider, model },
      };
    });
  }

  function handleModelChange(capability: ModelCapability, model: string) {
    setDraftCloud((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [capability]: { ...prev[capability], model },
      };
    });
  }

  async function handleSave() {
    if (!hasUnsavedChanges || saving || !draftMode || !draftCloud) return;
    setSaving(true);
    const ok = await update({
      mode: draftMode,
      cloud: {
        text: { provider: draftCloud.text.provider, model: draftCloud.text.model },
        speech: { provider: draftCloud.speech.provider, model: draftCloud.speech.model },
        transcription: { provider: draftCloud.transcription.provider, model: draftCloud.transcription.model },
      },
    });
    setSaving(false);
    // The hook's `update()` already called `setData(response)` on success,
    // which updates `data` to match what we just saved -- `hasUnsavedChanges`
    // (computed from `draftMode`/`draftCloud` vs `data`) becomes false
    // automatically since the draft already equals what was just persisted.
    if (ok) setSaved(true);
  }

  return (
    <div className={styles.screen} role="dialog" aria-label="Model Provider">
      <Header onClose={onClose} />

      <div className={styles.tabs} role="tablist">
        {MODE_TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={draftMode === key}
            className={styles.tab}
            data-active={draftMode === key}
            onClick={() => handleModeChange(key)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {draftMode === "local" && (
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <HardDrive size={18} className={styles.cardHeaderIcon} />
              <div>
                <h2 className={styles.cardTitle}>Local engine</h2>
                <p className={styles.cardHint}>Runs entirely on this device -- no cloud calls, no API keys.</p>
              </div>
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Engine</span>
              <div className={styles.staticValue}>oMLX</div>
              <p className={styles.fieldHelp}>More local inference engines coming soon.</p>
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Models</span>
              <LocalModelsControl serverAddress={serverAddress} />
            </div>
          </section>
        )}

        {draftMode === "cloud" && (
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <Cloud size={18} className={styles.cardHeaderIcon} />
              <div>
                <h2 className={styles.cardTitle}>Cloud providers</h2>
                <p className={styles.cardHint}>
                  Pick which provider and model serve each capability when running in Cloud mode.
                </p>
              </div>
            </div>

            {CAPABILITY_ROWS.map(({ key, label, icon: Icon }) => {
              const capabilityData = draftCloud[key];
              const isComingSoon = capabilityData.status === "coming_soon";
              const models = capabilityData.provider
                ? capabilityData.available_models[capabilityData.provider] ?? []
                : [];

              return (
                <div key={key} className={styles.capabilityRow} data-disabled={isComingSoon || undefined}>
                  <div className={styles.capabilityHeader}>
                    <Icon size={16} className={styles.capabilityIcon} />
                    <span className={styles.capabilityLabel}>{label}</span>
                    {isComingSoon && <Badge tone="neutral">Coming soon</Badge>}
                  </div>

                  <div className={styles.capabilitySelects}>
                    <select
                      className={styles.select}
                      value={capabilityData.provider ?? ""}
                      disabled={isComingSoon}
                      aria-label={`${label} provider`}
                      onChange={(event) => handleProviderChange(key, event.target.value)}
                    >
                      {!capabilityData.provider && <option value="">--</option>}
                      {capabilityData.available_providers.map((provider) => (
                        <option key={provider} value={provider}>
                          {provider}
                        </option>
                      ))}
                    </select>

                    <select
                      className={styles.select}
                      value={capabilityData.model ?? ""}
                      disabled={isComingSoon || !capabilityData.provider}
                      aria-label={`${label} model`}
                      onChange={(event) => handleModelChange(key, event.target.value)}
                    >
                      {!capabilityData.model && <option value="">--</option>}
                      {models.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {updateError && <p className={styles.errorText}>Couldn't save that change -- try again.</p>}
      </div>

      <footer className={styles.footer}>
        {saved && <span className={styles.saveStatusOk}>Saved</span>}
        {updateError && <span className={styles.saveStatusError}>Couldn't save -- try again.</span>}
        <Button variant="primary" loading={saving} disabled={!hasUnsavedChanges} onClick={handleSave}>
          Save changes
        </Button>
      </footer>
    </div>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <header className={styles.header}>
      <Button variant="ghost" onClick={onClose} aria-label="Back to settings">
        <ArrowLeft size={18} />
      </Button>
      <h1 className={styles.title}>Model Provider</h1>
    </header>
  );
}
