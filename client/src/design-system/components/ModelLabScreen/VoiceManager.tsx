import { useState } from "react";
import { Mic, Square, Trash2 } from "lucide-react";
import { Button } from "../../primitives/Button";
import { useWavRecorder } from "../../../hooks/useWavRecorder";
import type { ModelLabVoice } from "../../../hooks/useTranslatorConnection.types";
import styles from "./ModelLabScreen.module.css";

export interface VoiceManagerProps {
  voices: ModelLabVoice[];
  createVoice: (name: string, refText: string, audioFile: File, language?: string) => Promise<{ ok: boolean; error?: string }>;
  deleteVoice: (voiceId: string) => Promise<boolean>;
}

export function VoiceManager({ voices, createVoice, deleteVoice }: VoiceManagerProps) {
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formRefText, setFormRefText] = useState("");
  const [formAudioFile, setFormAudioFile] = useState<File | null>(null);
  const [formLanguage, setFormLanguage] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { recording, start: startRecording, stop: stopRecording, error: recorderError } = useWavRecorder();
  const [deleting, setDeleting] = useState<string | null>(null);

  async function handleRecordStart() {
    await startRecording();
  }

  async function handleRecordStop() {
    const file = await stopRecording();
    if (file) {
      setFormAudioFile(file);
    }
  }

  async function handleCreate() {
    if (!formName.trim() || !formRefText.trim() || !formAudioFile) {
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const result = await createVoice(formName, formRefText, formAudioFile, formLanguage || undefined);
      if (result.ok) {
        setFormName("");
        setFormRefText("");
        setFormAudioFile(null);
        setFormLanguage("");
        setShowForm(false);
      } else {
        setFormError(result.error ?? "Failed to create voice");
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(voiceId: string) {
    setDeleting(voiceId);
    try {
      await deleteVoice(voiceId);
    } finally {
      setDeleting(null);
    }
  }

  const canCreate = formName.trim() && formRefText.trim() && formAudioFile;

  return (
    <div className={styles.voiceManager}>
      <div className={styles.voiceManagerHeader}>
        <h3 className={styles.testTitle}>Voice library</h3>
        <p className={styles.fieldHelp}>Cloned voices appear as options in the Voice selector above after saving.</p>
      </div>

      {voices.length > 0 && (
        <div className={styles.voiceList}>
          {voices.map((voice) => (
            <div key={voice.id} className={styles.voiceItem}>
              <div className={styles.voiceItemContent}>
                <div className={styles.voiceItemName}>{voice.name}</div>
                {voice.language && <span className={styles.languageChip}>{voice.language}</span>}
              </div>
              <Button
                variant="secondary"
                onClick={() => handleDelete(voice.id)}
                disabled={deleting === voice.id}
                aria-label={`Delete voice ${voice.name}`}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Button variant="secondary" onClick={() => setShowForm(!showForm)}>
        {showForm ? "Cancel" : "Add voice"}
      </Button>

      {showForm && (
        <div className={styles.voiceFormPanel}>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="voice-name">
              Voice name
            </label>
            <input
              id="voice-name"
              type="text"
              className={styles.textInput}
              placeholder="e.g. Aunt Mei"
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="voice-ref-text">
              Reference transcript
            </label>
            <p className={styles.fieldHelp}>What does the reference audio say?</p>
            <textarea
              id="voice-ref-text"
              className={styles.textarea}
              placeholder="Type the exact text from your reference audio..."
              value={formRefText}
              onChange={(event) => setFormRefText(event.target.value)}
              rows={3}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>Reference audio</label>
            <p className={styles.fieldHelp}>Record or upload a 1-30 second audio clip.</p>
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
                      Record
                    </>
                  )}
                </Button>
                <input
                  type="file"
                  accept="audio/*"
                  className={styles.fileInput}
                  onChange={(event) => setFormAudioFile(event.target.files?.[0] ?? null)}
                />
              </div>
              {formAudioFile && (
                <p className={styles.selectedFile}>
                  Selected: <span>{formAudioFile.name}</span>
                </p>
              )}
            </div>
            {recorderError && <p className={styles.errorText}>{recorderError}</p>}
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="voice-language">
              Language (optional)
            </label>
            <input
              id="voice-language"
              type="text"
              className={styles.textInput}
              placeholder="e.g. zh, en"
              value={formLanguage}
              onChange={(event) => setFormLanguage(event.target.value)}
            />
          </div>

          {formError && <p className={styles.errorText}>{formError}</p>}

          <Button variant="secondary" loading={creating} disabled={!canCreate} onClick={handleCreate}>
            Create voice
          </Button>
        </div>
      )}
    </div>
  );
}
