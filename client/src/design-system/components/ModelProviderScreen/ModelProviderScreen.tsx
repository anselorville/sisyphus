import { useState } from "react";
import { ArrowLeft, Cloud, HardDrive, MessageSquare, Mic, Sparkles, Volume2 } from "lucide-react";
import { Button } from "../../primitives/Button";
import { Badge } from "../../primitives/Badge";
import { useModelProviders } from "../../../hooks/useModelProviders";
import { LocalModelsControl } from "../LocalModelsControl";
import type { ModelCapability, ModelProviderMode } from "../../../hooks/useTranslatorConnection.types";
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

/**
 * "Model Provider" -- the infrastructure-capability layer: which
 * provider/model actually serves each of the 4 model-capability types
 * (text/speech/transcription/omni), for either a Local or Cloud mode. This
 * is distinct from Model Lab (tuning/debug parameters like temperature and
 * persona) and Settings (business-level pipeline config like translation
 * direction) -- this screen answers "what serves the request," not "how is
 * it tuned" or "what does the product do with it."
 *
 * Reachable from SettingsScreen, same pattern as Model Lab. Saves on every
 * selection change (no separate "Save" button), matching Model Lab's
 * save-on-explicit-action posture but simplified further since each control
 * here is a single atomic choice rather than a multi-field draft.
 */
export function ModelProviderScreen({ serverAddress, onClose }: ModelProviderScreenProps) {
  const { data, loadError, updateError, update } = useModelProviders(serverAddress);
  const [pendingField, setPendingField] = useState<string | null>(null);

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

  if (!data) {
    return (
      <div className={styles.screen} role="dialog" aria-label="Model Provider">
        <Header onClose={onClose} />
        <div className={styles.content}>
          <p className={styles.sectionHint}>Loading model provider settings...</p>
        </div>
      </div>
    );
  }

  async function handleModeChange(mode: ModelProviderMode) {
    if (mode === data!.mode) return;
    setPendingField("mode");
    await update({ mode });
    setPendingField(null);
  }

  async function handleProviderChange(capability: ModelCapability, provider: string) {
    const capabilityData = data!.cloud[capability];
    const models = capabilityData.available_models[provider] ?? [];
    const model = models[0] ?? null;
    setPendingField(`${capability}-provider`);
    await update({ cloud: { [capability]: { provider, model } } });
    setPendingField(null);
  }

  async function handleModelChange(capability: ModelCapability, model: string) {
    const capabilityData = data!.cloud[capability];
    setPendingField(`${capability}-model`);
    await update({ cloud: { [capability]: { provider: capabilityData.provider, model } } });
    setPendingField(null);
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
            aria-selected={data.mode === key}
            className={styles.tab}
            data-active={data.mode === key}
            disabled={pendingField === "mode"}
            onClick={() => handleModeChange(key)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {data.mode === "local" && (
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

        {data.mode === "cloud" && (
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
              const capabilityData = data.cloud[key];
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
                      disabled={isComingSoon || pendingField === `${key}-provider`}
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
                      disabled={isComingSoon || !capabilityData.provider || pendingField === `${key}-model`}
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
