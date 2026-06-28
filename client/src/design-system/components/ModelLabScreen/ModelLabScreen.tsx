import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, MessageSquare, Mic, Volume2 } from "lucide-react";
import { Button } from "../../primitives/Button";
import { Badge } from "../../primitives/Badge";
import { useModelLab } from "../../../hooks/useModelLab";
import type { ModelLabAdapter, ModelLabCapability, ModelLabField, ModelLabFieldValue } from "../../../hooks/useTranslatorConnection.types";
import styles from "./ModelLabScreen.module.css";

export interface ModelLabScreenProps {
  serverAddress: string;
  onClose: () => void;
}

const CAPABILITY_TABS: { key: ModelLabCapability; label: string; icon: typeof MessageSquare }[] = [
  { key: "text", label: "Text", icon: MessageSquare },
  { key: "speech", label: "Voice", icon: Volume2 },
  { key: "transcription", label: "Listening", icon: Mic },
];

type DraftMap = Record<string, ModelLabFieldValue>;

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ModelLabField;
  value: ModelLabFieldValue | undefined;
  onChange: (value: ModelLabFieldValue) => void;
}) {
  const inputId = `model-lab-${field.key}`;

  if (field.kind === "textarea") {
    return (
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={inputId}>
          {field.label}
        </label>
        {field.help && <p className={styles.fieldHelp}>{field.help}</p>}
        <textarea
          id={inputId}
          className={styles.textarea}
          value={(value as string) ?? ""}
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
          rows={field.key.includes("system_prompt") ? 8 : 3}
        />
      </div>
    );
  }

  if (field.kind === "select") {
    return (
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={inputId}>
          {field.label}
        </label>
        {field.help && <p className={styles.fieldHelp}>{field.help}</p>}
        <select
          id={inputId}
          className={styles.select}
          value={(value as string) ?? ""}
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

  if (field.kind === "boolean") {
    return (
      <div className={styles.field}>
        <label className={styles.checkboxRow} htmlFor={inputId}>
          <input
            id={inputId}
            type="checkbox"
            className={styles.checkbox}
            checked={Boolean(value)}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className={styles.fieldLabel}>{field.label}</span>
        </label>
        {field.help && <p className={styles.fieldHelp}>{field.help}</p>}
      </div>
    );
  }

  if (field.kind === "number") {
    const hasBounds = field.min !== undefined && field.max !== undefined;
    return (
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={inputId}>
          {field.label}
          {value !== null && value !== undefined && <span className={styles.fieldValueBadge}>{String(value)}</span>}
        </label>
        {field.help && <p className={styles.fieldHelp}>{field.help}</p>}
        {hasBounds ? (
          <input
            id={inputId}
            type="range"
            className={styles.slider}
            min={field.min}
            max={field.max}
            step={field.step ?? 0.05}
            value={(value as number) ?? field.min ?? 0}
            onChange={(event) => onChange(Number(event.target.value))}
          />
        ) : (
          <input
            id={inputId}
            type="number"
            className={styles.textInput}
            step={field.step ?? 1}
            value={value === null || value === undefined ? "" : (value as number)}
            onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
          />
        )}
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
        value={(value as string) ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      />
    </div>
  );
}

function TextTestPanel({
  adapterId,
  draft,
  previewText,
}: {
  adapterId: string;
  draft: DraftMap;
  previewText: (adapterId: string, draft: DraftMap, inputText: string) => Promise<{ output_text: string }>;
}) {
  const [inputText, setInputText] = useState("");
  const [output, setOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(false);

  async function handleRun() {
    if (running) return;
    setRunning(true);
    setError(false);
    try {
      const result = await previewText(adapterId, draft, inputText);
      setOutput(result.output_text);
    } catch {
      setError(true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={styles.testPanel}>
      <h3 className={styles.testTitle}>Test it now</h3>
      <p className={styles.fieldHelp}>Runs the actual model with your current (unsaved) settings above.</p>
      <input
        type="text"
        className={styles.textInput}
        placeholder="Type a sample input..."
        value={inputText}
        onChange={(event) => setInputText(event.target.value)}
      />
      <Button variant="secondary" loading={running} disabled={!inputText.trim()} onClick={handleRun}>
        Run test
      </Button>
      {error && <p className={styles.errorText}>Couldn't run the test -- try again.</p>}
      {output !== null && !error && (
        <div className={styles.testResult}>
          <p className={styles.testResultLabel}>Output</p>
          <p className={styles.testResultText}>{output}</p>
        </div>
      )}
    </div>
  );
}

function SpeechTestPanel({
  adapterId,
  draft,
  previewSpeech,
}: {
  adapterId: string;
  draft: DraftMap;
  previewSpeech: (adapterId: string, draft: DraftMap, inputText: string) => Promise<Blob>;
}) {
  const [inputText, setInputText] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(false);

  // Revoke the previous object URL whenever a new one is created or the
  // component unmounts, so we don't leak blob URLs across repeated test runs.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  async function handleRun() {
    if (running) return;
    setRunning(true);
    setError(false);
    try {
      const blob = await previewSpeech(adapterId, draft, inputText);
      const url = URL.createObjectURL(blob);
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return url;
      });
    } catch {
      setError(true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={styles.testPanel}>
      <h3 className={styles.testTitle}>Test it now</h3>
      <p className={styles.fieldHelp}>Synthesizes the text below with your current (unsaved) settings above.</p>
      <input
        type="text"
        className={styles.textInput}
        placeholder="Type sample text to synthesize..."
        value={inputText}
        onChange={(event) => setInputText(event.target.value)}
      />
      <Button variant="secondary" loading={running} disabled={!inputText.trim()} onClick={handleRun}>
        Run test
      </Button>
      {error && <p className={styles.errorText}>Couldn't run the test -- try again.</p>}
      {audioUrl && !error && (
        <div className={styles.testResult}>
          <p className={styles.testResultLabel}>Output</p>
          <audio controls src={audioUrl} className={styles.audioPlayer} />
        </div>
      )}
    </div>
  );
}

function TranscriptionTestPanel({
  adapterId,
  draft,
  previewTranscription,
}: {
  adapterId: string;
  draft: DraftMap;
  previewTranscription: (adapterId: string, draft: DraftMap, audioFile: File) => Promise<{ transcript: string }>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(false);

  async function handleRun() {
    if (running || !file) return;
    setRunning(true);
    setError(false);
    try {
      const result = await previewTranscription(adapterId, draft, file);
      setTranscript(result.transcript);
    } catch {
      setError(true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={styles.testPanel}>
      <h3 className={styles.testTitle}>Test it now</h3>
      <p className={styles.fieldHelp}>Transcribes an audio clip with your current (unsaved) settings above.</p>
      <input
        type="file"
        accept="audio/*"
        className={styles.fileInput}
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      <Button variant="secondary" loading={running} disabled={!file} onClick={handleRun}>
        Run test
      </Button>
      {error && <p className={styles.errorText}>Couldn't run the test -- try again.</p>}
      {transcript !== null && !error && (
        <div className={styles.testResult}>
          <p className={styles.testResultLabel}>Transcript</p>
          <p className={styles.testResultText}>{transcript}</p>
        </div>
      )}
    </div>
  );
}

/**
 * "Model Lab" -- the dedicated settings branch for tuning text/voice/
 * listening parameters per the product owner's explicit ask: model tuning is
 * a major product surface, not an afterthought crammed into the main
 * Settings screen.
 *
 * Unlike the old fixed-shape version (one hardcoded field set per role),
 * this renders entirely from the server's dynamic schema
 * (`GET /api/model-lab/schema`): each capability (Text/Voice/Listening) can
 * expose multiple "adapters" (e.g. Cloud, or whichever local oMLX model is
 * active), each with its own field list. Switching adapters re-renders a
 * different form -- nothing about the fields is hardcoded here.
 *
 * Field edits are local draft state, not saved on every keystroke (unlike
 * ModelProviderScreen's immediate-save pattern) -- the whole point of the
 * "Test it now" panel below the fields is to let the user try draft values
 * against a real model call *before* committing via the explicit "Save"
 * button, mirroring the old screen's save-button affordance.
 */
export function ModelLabScreen({ serverAddress, onClose }: ModelLabScreenProps) {
  const { schema, values, loadError, saveState, setSaveState, saveValues, previewText, previewSpeech, previewTranscription } =
    useModelLab(serverAddress);

  const [activeCapability, setActiveCapability] = useState<ModelLabCapability>("text");
  const [activeAdapterByCapability, setActiveAdapterByCapability] = useState<Record<string, string>>({});
  const [draftByAdapter, setDraftByAdapter] = useState<Record<string, DraftMap>>({});

  // Clear a transient "saved" confirmation after a few seconds so it doesn't
  // linger indefinitely as stale-looking UI.
  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [saveState, setSaveState]);

  const adaptersForCapability = useMemo<ModelLabAdapter[]>(() => {
    if (!schema) return [];
    return schema[activeCapability]?.adapters ?? [];
  }, [schema, activeCapability]);

  const activeAdapterId = activeAdapterByCapability[activeCapability] ?? adaptersForCapability[0]?.id ?? null;
  const activeAdapter = adaptersForCapability.find((adapter) => adapter.id === activeAdapterId) ?? null;

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

  if (!schema || !values) {
    return (
      <div className={styles.screen} role="dialog" aria-label="Model Lab">
        <Header onClose={onClose} />
        <div className={styles.content}>
          <p className={styles.sectionHint}>Loading model settings...</p>
        </div>
      </div>
    );
  }

  function draftFor(adapterId: string, key: string): ModelLabFieldValue | undefined {
    const draftSection = draftByAdapter[adapterId];
    if (draftSection && key in draftSection) return draftSection[key];
    const saved = values?.[adapterId];
    if (saved && key in saved) return saved[key];
    return undefined;
  }

  function setDraftField(adapterId: string, key: string, value: ModelLabFieldValue) {
    setDraftByAdapter((prev) => ({
      ...prev,
      [adapterId]: { ...(prev[adapterId] ?? {}), [key]: value },
    }));
  }

  function draftMapFor(adapterId: string): DraftMap {
    const saved = values?.[adapterId] ?? {};
    const draftSection = draftByAdapter[adapterId] ?? {};
    return { ...saved, ...draftSection };
  }

  const hasUnsavedChanges = activeAdapterId ? Object.keys(draftByAdapter[activeAdapterId] ?? {}).length > 0 : false;

  async function handleSave() {
    if (!activeAdapterId || !hasUnsavedChanges) return;
    const ok = await saveValues(activeAdapterId, draftByAdapter[activeAdapterId]);
    if (ok) {
      setDraftByAdapter((prev) => {
        const next = { ...prev };
        delete next[activeAdapterId];
        return next;
      });
    }
  }

  return (
    <div className={styles.screen} role="dialog" aria-label="Model Lab">
      <Header onClose={onClose} />

      <div className={styles.tabs} role="tablist">
        {CAPABILITY_TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeCapability === key}
            className={styles.tab}
            data-active={activeCapability === key}
            onClick={() => setActiveCapability(key)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {adaptersForCapability.length === 0 && (
          <p className={styles.sectionHint}>No adapters available for this capability yet.</p>
        )}

        {adaptersForCapability.length > 1 && (
          <div className={styles.adapterTabs} role="tablist" aria-label="Adapter">
            {adaptersForCapability.map((adapter) => (
              <button
                key={adapter.id}
                type="button"
                role="tab"
                aria-selected={activeAdapterId === adapter.id}
                className={styles.adapterTab}
                data-active={activeAdapterId === adapter.id}
                onClick={() => setActiveAdapterByCapability((prev) => ({ ...prev, [activeCapability]: adapter.id }))}
              >
                {adapter.label}
              </button>
            ))}
          </div>
        )}

        {activeAdapter && (
          <section className={styles.card} data-marquee="true">
            <div className={styles.cardHeader}>
              <Badge tone="neutral">{activeAdapter.label}</Badge>
            </div>

            {activeAdapter.fields.map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                value={draftFor(activeAdapter.id, field.key)}
                onChange={(value) => setDraftField(activeAdapter.id, field.key, value)}
              />
            ))}

            {activeCapability === "text" && (
              <TextTestPanel adapterId={activeAdapter.id} draft={draftMapFor(activeAdapter.id)} previewText={previewText} />
            )}
            {activeCapability === "speech" && (
              <SpeechTestPanel
                adapterId={activeAdapter.id}
                draft={draftMapFor(activeAdapter.id)}
                previewSpeech={previewSpeech}
              />
            )}
            {activeCapability === "transcription" && (
              <TranscriptionTestPanel
                adapterId={activeAdapter.id}
                draft={draftMapFor(activeAdapter.id)}
                previewTranscription={previewTranscription}
              />
            )}
          </section>
        )}

        <p className={styles.liveNote}>
          Saved settings persist immediately, but don't take effect until the next connection -- the engine and its
          services are built once when a call starts. Use "Test it now" above to try your draft values right away.
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
