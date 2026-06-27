import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Brain, Mic, Sparkles, Volume2 } from "lucide-react";
import { Button } from "../../primitives/Button";
import { Badge } from "../../primitives/Badge";
import { useModelSettings } from "../../../hooks/useModelSettings";
import type {
  ModelSettingsField,
  ModelSettingsPartialUpdate,
  ModelSettingsValues,
} from "../../../hooks/useTranslatorConnection.types";
import type { EngineMode } from "../EngineStatusChip";
import styles from "./ModelLabScreen.module.css";

export interface ModelLabScreenProps {
  serverAddress: string;
  engineMode: EngineMode;
  onClose: () => void;
}

type RoleKey = "llm" | "tts" | "stt";

const ROLE_TABS: { key: RoleKey; label: string; icon: typeof Brain }[] = [
  { key: "llm", label: "LLM", icon: Brain },
  { key: "tts", label: "TTS", icon: Volume2 },
  { key: "stt", label: "ASR", icon: Mic },
];

// EngineMode ("cloud" / "offline" / "local-dev" / "unknown") -> the schema's
// per-engine TTS key ("cloud" / "omlx"). "offline" (Piper) has no dedicated
// schema section yet -- falls back to the oMLX field set as the closer
// analog (both are free-running local synth engines with no named-voice
// library), rather than fabricating a third section with guessed fields.
function ttsEngineKey(mode: EngineMode): "cloud" | "omlx" {
  return mode === "cloud" ? "cloud" : "omlx";
}

type DraftValue = string | number | null;

function fieldValue(values: ModelSettingsValues | undefined, role: RoleKey, key: string): DraftValue {
  if (!values) return null;
  const section = values[role] as unknown as Record<string, DraftValue>;
  return section[key] ?? null;
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ModelSettingsField;
  value: DraftValue;
  onChange: (value: DraftValue) => void;
}) {
  const inputId = `model-lab-${field.key}`;

  if (field.type === "textarea") {
    return (
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={inputId}>
          {field.label}
        </label>
        {field.help && <p className={styles.fieldHelp}>{field.help}</p>}
        <textarea
          id={inputId}
          className={styles.textarea}
          value={value ?? ""}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
          rows={field.key.includes("system_prompt") ? 8 : 3}
        />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={inputId}>
          {field.label}
        </label>
        {field.help && <p className={styles.fieldHelp}>{field.help}</p>}
        <select
          id={inputId}
          className={styles.select}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">Default</option>
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === "number") {
    return (
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={inputId}>
          {field.label}
          {value !== null && <span className={styles.fieldValueBadge}>{value}</span>}
        </label>
        {field.help && <p className={styles.fieldHelp}>{field.help}</p>}
        <input
          id={inputId}
          type="range"
          className={styles.slider}
          min={field.min ?? 0}
          max={field.max ?? 1}
          step={field.step ?? 0.05}
          value={value ?? field.min ?? 0}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
    );
  }

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={inputId}>
        {field.label}
      </label>
      {field.help && <p className={styles.fieldHelp}>{field.help}</p>}
      <input
        id={inputId}
        type="text"
        className={styles.textInput}
        value={value ?? ""}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      />
    </div>
  );
}

/**
 * "Model Lab" -- the dedicated settings branch for tuning ASR/LLM/TTS
 * parameters per the product owner's explicit ask: model tuning is a major
 * product surface, not an afterthought crammed into the main Settings
 * screen, and the LLM's persona/system-prompt must be front-and-center
 * editable (this product is not locked to being a translator).
 *
 * Reachable from SettingsScreen. Renders one tab/card per model role
 * (LLM/TTS/ASR); TTS's field set additionally depends on which engine is
 * active, since oMLX and Cartesia expose genuinely different parameter
 * vocabularies (see app/model_settings.py's `model_settings_schema`).
 *
 * Honesty note shown to the user: saving here persists the override, but it
 * does not yet take live effect -- the pipeline still needs a follow-up
 * wiring change (see app/model_settings.py's module docstring) to actually
 * read this store when building a connection's services. Until then, this
 * screen is real, persisted, validated... and silently inert end-to-end.
 * That's stated plainly rather than implied otherwise.
 */
export function ModelLabScreen({ serverAddress, engineMode, onClose }: ModelLabScreenProps) {
  const { data, loadError, saveState, setSaveState, save } = useModelSettings(serverAddress);
  const [activeRole, setActiveRole] = useState<RoleKey>("llm");
  const [draft, setDraft] = useState<ModelSettingsPartialUpdate>({});

  // Reset the draft whenever fresh server data arrives (initial load, or
  // right after a successful save) so the form always reflects persisted
  // truth rather than accumulating stale edits across saves.
  useEffect(() => {
    if (data) setDraft({});
  }, [data]);

  // Clear a transient "saved" confirmation after a few seconds so it doesn't
  // linger indefinitely as stale-looking UI.
  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [saveState, setSaveState]);

  const ttsKey = useMemo(() => ttsEngineKey(engineMode), [engineMode]);

  if (loadError) {
    return (
      <div className={styles.screen} role="dialog" aria-label="Model Lab">
        <Header onClose={onClose} />
        <div className={styles.content}>
          <p className={styles.errorText}>
            Couldn't reach the server to load model settings -- check the connection in Settings and try again.
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={styles.screen} role="dialog" aria-label="Model Lab">
        <Header onClose={onClose} />
        <div className={styles.content}>
          <p className={styles.sectionHint}>Loading model settings...</p>
        </div>
      </div>
    );
  }

  const llmSchema = data.schema.llm;
  const ttsSchema = data.schema.tts;
  const sttSchema = data.schema.stt;
  const ttsEngineSection = ttsSchema.engines?.[ttsKey];

  function draftFor(role: RoleKey, key: string): DraftValue {
    const draftSection = draft[role] as Record<string, DraftValue> | undefined;
    if (draftSection && key in draftSection) return draftSection[key];
    return fieldValue(data!.values, role, key);
  }

  function setDraftField(role: RoleKey, key: string, value: DraftValue) {
    setDraft((prev) => ({
      ...prev,
      [role]: { ...(prev[role] as Record<string, DraftValue> | undefined), [key]: value },
    }));
  }

  const hasUnsavedChanges = Object.keys(draft).length > 0;

  async function handleSave() {
    if (!hasUnsavedChanges) return;
    await save(draft);
  }

  function handleResetPersona() {
    setDraftField("llm", "system_prompt_override", null);
  }

  return (
    <div className={styles.screen} role="dialog" aria-label="Model Lab">
      <Header onClose={onClose} />

      <div className={styles.tabs} role="tablist">
        {ROLE_TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeRole === key}
            className={styles.tab}
            data-active={activeRole === key}
            onClick={() => setActiveRole(key)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {activeRole === "llm" && (
          <section className={styles.card} data-marquee="true">
            <div className={styles.cardHeader}>
              <Sparkles size={18} className={styles.cardHeaderIcon} />
              <div>
                <h2 className={styles.cardTitle}>{llmSchema.label}</h2>
                <p className={styles.cardHint}>{llmSchema.help}</p>
              </div>
            </div>

            <div className={styles.personaBlock}>
              <div className={styles.personaHeaderRow}>
                <span className={styles.personaLabel}>Persona / system prompt</span>
                <button type="button" className={styles.resetLink} onClick={handleResetPersona}>
                  Reset to default
                </button>
              </div>
              <p className={styles.fieldHelp}>{llmSchema.fields?.[0]?.help}</p>
              <textarea
                className={styles.personaTextarea}
                rows={9}
                value={draftFor("llm", "system_prompt_override") ?? ""}
                placeholder={llmSchema.fields?.[0]?.placeholder}
                onChange={(event) =>
                  setDraftField("llm", "system_prompt_override", event.target.value === "" ? null : event.target.value)
                }
              />
            </div>

            {llmSchema.fields?.slice(1).map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                value={draftFor("llm", field.key)}
                onChange={(value) => setDraftField("llm", field.key, value)}
              />
            ))}
          </section>
        )}

        {activeRole === "tts" && (
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <Volume2 size={18} className={styles.cardHeaderIcon} />
              <div>
                <h2 className={styles.cardTitle}>{ttsSchema.label}</h2>
                <p className={styles.cardHint}>{ttsSchema.help}</p>
              </div>
            </div>
            {ttsEngineSection && (
              <>
                <Badge tone="neutral">{ttsEngineSection.label}</Badge>
                {ttsEngineSection.fields.map((field) => (
                  <FieldControl
                    key={field.key}
                    field={field}
                    value={draftFor("tts", field.key)}
                    onChange={(value) => setDraftField("tts", field.key, value)}
                  />
                ))}
              </>
            )}
          </section>
        )}

        {activeRole === "stt" && (
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <Mic size={18} className={styles.cardHeaderIcon} />
              <div>
                <h2 className={styles.cardTitle}>{sttSchema.label}</h2>
                <p className={styles.cardHint}>{sttSchema.help}</p>
              </div>
            </div>
            {sttSchema.fields?.map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                value={draftFor("stt", field.key)}
                onChange={(value) => setDraftField("stt", field.key, value)}
              />
            ))}
          </section>
        )}

        <p className={styles.liveNote}>
          Saved settings persist immediately, but don't take effect until the next connection -- the engine and its
          services are built once when a call starts.
        </p>
      </div>

      <footer className={styles.footer}>
        {saveState === "saved" && <span className={styles.saveStatusOk}>Saved</span>}
        {saveState === "error" && <span className={styles.saveStatusError}>Couldn't save -- try again.</span>}
        <Button variant="primary" loading={saveState === "saving"} disabled={!hasUnsavedChanges} onClick={handleSave}>
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
      <h1 className={styles.title}>Model Lab</h1>
    </header>
  );
}
