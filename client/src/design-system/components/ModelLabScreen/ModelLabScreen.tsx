import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Link2, MessageSquare, Mic, Square, Trash2, Upload, Volume2 } from "lucide-react";
import { Button } from "../../primitives/Button";
import { Badge } from "../../primitives/Badge";
import { useModelLab } from "../../../hooks/useModelLab";
import { useWavRecorder } from "../../../hooks/useWavRecorder";
import type { ModelLabAdapter, ModelLabCapability, ModelLabField, ModelLabFieldValue, ModelLabPreset } from "../../../hooks/useTranslatorConnection.types";
import { PresetBar } from "./PresetBar";
import { VoiceManager } from "./VoiceManager";
import { ChainTestPanel } from "./ChainTestPanel";
import styles from "./ModelLabScreen.module.css";

export interface ModelLabScreenProps {
  serverAddress: string;
  onClose: () => void;
}

type TabKey = ModelLabCapability | "chain";

const CAPABILITY_TABS: { key: TabKey; label: string; icon: typeof MessageSquare }[] = [
  { key: "text", label: "Text", icon: MessageSquare },
  { key: "speech", label: "Voice", icon: Volume2 },
  { key: "transcription", label: "Listening", icon: Mic },
  { key: "chain", label: "Full chain", icon: Link2 },
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
  previewText: (adapterId: string, draft: DraftMap, inputText: string) => Promise<{ output_text: string; timing?: { total_ms: number } }>;
}) {
  const [inputText, setInputText] = useState("");
  const [output, setOutput] = useState<string | null>(null);
  const [timing, setTiming] = useState<{ total_ms: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(false);

  async function handleRun() {
    if (running) return;
    setRunning(true);
    setError(false);
    try {
      const result = await previewText(adapterId, draft, inputText);
      setOutput(result.output_text);
      setTiming(result.timing ?? null);
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
          {timing && <p className={styles.fieldHelp}>Took {(timing.total_ms / 1000).toFixed(1)}s</p>}
        </div>
      )}
    </div>
  );
}

interface SpeechHistoryEntry {
  url: string;
  label: string;
  params: Record<string, ModelLabFieldValue>;
  totalMs: number | null;
  audioMs: number | null;
}

function SpeechTestPanel({
  adapterId,
  draft,
  previewSpeech,
}: {
  adapterId: string;
  draft: DraftMap;
  previewSpeech: (adapterId: string, draft: DraftMap, inputText: string) => Promise<{ blob: Blob; totalMs: number | null; audioMs: number | null }>;
}) {
  const [inputText, setInputText] = useState("");
  const [history, setHistory] = useState<SpeechHistoryEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(false);

  // Revoke all history URLs on unmount
  useEffect(() => {
    return () => {
      history.forEach((entry) => {
        if (entry.url) URL.revokeObjectURL(entry.url);
      });
    };
  }, [history]);

  async function handleRun() {
    if (running) return;
    setRunning(true);
    setError(false);
    try {
      const result = await previewSpeech(adapterId, draft, inputText);
      const url = URL.createObjectURL(result.blob);
      const label = `#${history.length + 1}`;
      const newEntry: SpeechHistoryEntry = {
        url,
        label,
        params: { ...draft },
        totalMs: result.totalMs,
        audioMs: result.audioMs,
      };

      // Add to history at the beginning (newest first)
      setHistory((prev) => {
        const updated = [newEntry, ...prev];
        // Keep only the latest 10 entries, revoke old URLs
        if (updated.length > 10) {
          const removed = updated.slice(10);
          removed.forEach((entry) => {
            if (entry.url) URL.revokeObjectURL(entry.url);
          });
          return updated.slice(0, 10);
        }
        return updated;
      });
    } catch {
      setError(true);
    } finally {
      setRunning(false);
    }
  }

  function handleDeleteEntry(index: number) {
    setHistory((prev) => {
      const entry = prev[index];
      if (entry?.url) URL.revokeObjectURL(entry.url);
      return prev.filter((_, i) => i !== index);
    });
  }

  function formatParams(params: Record<string, ModelLabFieldValue>): string {
    return Object.entries(params)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => {
        let displayValue = String(value);
        if (displayValue.length > 40) {
          displayValue = displayValue.substring(0, 40) + "...";
        }
        return `${key}=${displayValue}`;
      })
      .join(", ");
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

      {history.length > 0 && (
        <div className={styles.historyList}>
          {history.map((entry, index) => (
            <div key={index} className={styles.historyItem}>
              <div className={styles.historyItemHeader}>
                <span className={styles.historyItemLabel}>{entry.label}</span>
                <audio controls src={entry.url} className={styles.audioPlayer} />
                <Button
                  variant="secondary"
                  onClick={() => handleDeleteEntry(index)}
                  aria-label={`Delete history entry ${entry.label}`}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              <div className={styles.historyItemParams}>{formatParams(entry.params)}</div>
              {(entry.totalMs !== null || entry.audioMs !== null) && (
                <div className={styles.historyItemTiming}>
                  {entry.totalMs !== null && `Synthesis ${(entry.totalMs / 1000).toFixed(1)}s`}
                  {entry.totalMs !== null && entry.audioMs !== null && " · "}
                  {entry.audioMs !== null && `audio ${(entry.audioMs / 1000).toFixed(1)}s`}
                </div>
              )}
            </div>
          ))}
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
  previewTranscription: (adapterId: string, draft: DraftMap, audioFile: File) => Promise<{ transcript: string; timing?: { total_ms: number } }>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [timing, setTiming] = useState<{ total_ms: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [testError, setTestError] = useState(false);
  const { recording, start, stop, error: recorderError } = useWavRecorder();

  async function handleRecordStart() {
    await start();
  }

  async function handleRecordStop() {
    const recordedFile = await stop();
    if (recordedFile) {
      setFile(recordedFile);
    }
  }

  async function handleRun() {
    if (running || !file) return;
    setRunning(true);
    setTestError(false);
    try {
      const result = await previewTranscription(adapterId, draft, file);
      setTranscript(result.transcript);
      setTiming(result.timing ?? null);
    } catch {
      setTestError(true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={styles.testPanel}>
      <h3 className={styles.testTitle}>Test it now</h3>
      <p className={styles.fieldHelp}>Transcribes an audio clip with your current (unsaved) settings above.</p>

      <div className={styles.recordingControls}>
        <div className={styles.recordingRow}>
          <Button
            variant="secondary"
            onClick={recording ? handleRecordStop : handleRecordStart}
          >
            {recording ? (
              <>
                <Square size={16} />
                Stop recording
              </>
            ) : (
              <>
                <Mic size={16} />
                Record a clip
              </>
            )}
          </Button>
          <Button
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={16} />
            Pick a file
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            className={styles.fileInputHidden}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>
        {file && (
          <p className={styles.selectedFile}>
            Selected: <span>{file.name}</span>
          </p>
        )}
      </div>

      {recorderError && <p className={styles.errorText}>Microphone unavailable -- check permissions.</p>}

      <Button variant="secondary" loading={running} disabled={!file} onClick={handleRun}>
        Run test
      </Button>
      {testError && <p className={styles.errorText}>Couldn't run the test -- try again.</p>}
      {(transcript ?? "") !== "" && !testError && (
        <div className={styles.testResult}>
          <p className={styles.testResultLabel}>Transcript</p>
          <p className={styles.testResultText}>{transcript}</p>
          {timing && <p className={styles.fieldHelp}>Took {(timing.total_ms / 1000).toFixed(1)}s</p>}
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
  const {
    schema,
    values,
    presets,
    voices,
    loadError,
    saveState,
    setSaveState,
    saveValues,
    previewText,
    previewSpeech,
    previewTranscription,
    previewChain,
    createPreset,
    deletePreset,
    createVoice,
    deleteVoice,
  } = useModelLab(serverAddress);

  const [activeCapability, setActiveCapability] = useState<TabKey>("text");
  const [activeAdapterByCapability, setActiveAdapterByCapability] = useState<Record<string, string>>({});
  const [draftByAdapter, setDraftByAdapter] = useState<Record<string, DraftMap>>({});
  const [selectedPresetByCapability, setSelectedPresetByCapability] = useState<Record<string, string | null>>({});

  // Clear a transient "saved" confirmation after a few seconds so it doesn't
  // linger indefinitely as stale-looking UI.
  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [saveState, setSaveState]);

  const adaptersForCapability = useMemo<ModelLabAdapter[]>(() => {
    if (!schema || activeCapability === "chain") return [];
    return schema[activeCapability as ModelLabCapability]?.adapters ?? [];
  }, [schema, activeCapability]);

  const activeAdapterId = activeCapability === "chain" ? null : (activeAdapterByCapability[activeCapability] ?? adaptersForCapability[0]?.id ?? null);
  const activeAdapter = activeCapability === "chain" ? null : (adaptersForCapability.find((adapter) => adapter.id === activeAdapterId) ?? null);

  // Helper to get active adapter id for a specific capability (used for chain tab)
  function getActiveAdapterForCapability(capability: ModelLabCapability): string | null {
    if (!schema) return null;
    const adapters = schema[capability]?.adapters ?? [];
    return activeAdapterByCapability[capability] ?? adapters[0]?.id ?? null;
  }

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

  // Calculate if the current draft differs from the selected preset
  function isPresetModified(adapterId: string): boolean {
    if (activeCapability === "chain") return false;
    const selectedPresetId = selectedPresetByCapability[activeCapability];
    if (!selectedPresetId) return false;

    const presetList = presets[activeCapability as ModelLabCapability] ?? [];
    const preset = presetList.find((p) => p.id === selectedPresetId);
    if (!preset) return false;

    // Get the adapter's field spec to know which keys to compare
    const adapter = activeAdapter;
    if (!adapter) return false;

    const adapterFieldKeys = new Set(adapter.fields.map((f) => f.key));
    const currentDraft = draftMapFor(adapterId);

    // Compare only the fields that exist in the adapter spec
    for (const key of adapterFieldKeys) {
      const draftValue = currentDraft[key] ?? null;
      const presetValue = preset.values[key] ?? null;
      if (draftValue !== presetValue) {
        return true;
      }
    }
    return false;
  }

  async function handlePresetApply(preset: ModelLabPreset) {
    if (activeCapability === "chain" || !activeAdapterId || !activeAdapter) return;

    // Get the adapter's field spec to know which keys to apply
    const adapterFieldKeys = new Set(activeAdapter.fields.map((f) => f.key));

    // Apply only the preset's values that are declared in the adapter's spec
    for (const key of adapterFieldKeys) {
      const value = preset.values[key] ?? null;
      setDraftField(activeAdapterId, key, value);
    }

    // Record this preset as selected for the current capability
    setSelectedPresetByCapability((prev) => ({ ...prev, [activeCapability]: preset.id }));
  }

  async function handlePresetSaveAs(name: string): Promise<boolean> {
    if (activeCapability === "chain" || !activeAdapterId || !activeAdapter) return false;

    // Get the adapter's field spec to know which keys to include in the preset
    const adapterFieldKeys = new Set(activeAdapter.fields.map((f) => f.key));
    const currentDraft = draftMapFor(activeAdapterId);

    // Restrict to only fields declared in the adapter spec, drop null/undefined
    const presetValues: Record<string, ModelLabFieldValue> = {};
    for (const key of adapterFieldKeys) {
      const value = currentDraft[key];
      if (value !== null && value !== undefined) {
        presetValues[key] = value;
      }
    }

    const created = await createPreset(activeCapability as ModelLabCapability, name, presetValues);
    if (created) {
      setSelectedPresetByCapability((prev) => ({ ...prev, [activeCapability]: created.id }));
      return true;
    }
    return false;
  }

  async function handlePresetDelete(preset: ModelLabPreset) {
    if (activeCapability === "chain") return;
    const ok = await deletePreset(activeCapability as ModelLabCapability, preset.id);
    if (ok) {
      // Clear selection if it was the deleted preset
      if (selectedPresetByCapability[activeCapability] === preset.id) {
        setSelectedPresetByCapability((prev) => ({ ...prev, [activeCapability]: null }));
      }
    }
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
        {activeCapability === "chain" ? (
          <>
            <ChainTestPanel
              adapters={{
                stt: getActiveAdapterForCapability("transcription"),
                llm: getActiveAdapterForCapability("text"),
                tts: getActiveAdapterForCapability("speech"),
              }}
              buildValues={() => {
                const sttId = getActiveAdapterForCapability("transcription");
                const llmId = getActiveAdapterForCapability("text");
                const ttsId = getActiveAdapterForCapability("speech");
                const result: Record<string, Record<string, ModelLabFieldValue>> = {};
                if (sttId) result[sttId] = draftMapFor(sttId);
                if (llmId) result[llmId] = draftMapFor(llmId);
                if (ttsId) result[ttsId] = draftMapFor(ttsId);
                return result;
              }}
              previewChain={previewChain}
            />
            <p className={styles.liveNote}>
              Saved settings persist immediately, but don't take effect until the next connection -- the engine and its
              services are built once when a call starts. Use "Test it now" above to try your draft values right away.
            </p>
          </>
        ) : (
          <>
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

            {(activeCapability === "text" || activeCapability === "speech") && activeAdapterId && (
              <PresetBar
                presets={presets[activeCapability as ModelLabCapability] ?? []}
                selectedId={selectedPresetByCapability[activeCapability] ?? null}
                modified={isPresetModified(activeAdapterId)}
                onApply={handlePresetApply}
                onSaveAs={handlePresetSaveAs}
                onDelete={handlePresetDelete}
              />
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

            {activeCapability === "speech" && activeAdapter?.id.startsWith("omlx:") && (
              <VoiceManager voices={voices} createVoice={createVoice} deleteVoice={deleteVoice} />
            )}

            <p className={styles.liveNote}>
              Saved settings persist immediately, but don't take effect until the next connection -- the engine and its
              services are built once when a call starts. Use "Test it now" above to try your draft values right away.
            </p>
          </>
        )}
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
