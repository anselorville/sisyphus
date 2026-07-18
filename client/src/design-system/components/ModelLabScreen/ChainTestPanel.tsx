import { useEffect, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "../../primitives/Button";
import { Badge } from "../../primitives/Badge";
import { useWavRecorder } from "../../../hooks/useWavRecorder";
import type { ChainPreviewResult, ModelLabFieldValue } from "../../../hooks/useTranslatorConnection.types";
import styles from "./ModelLabScreen.module.css";

export interface ChainTestPanelProps {
  adapters: {
    stt: string | null;
    llm: string | null;
    tts: string | null;
  };
  buildValues: () => Record<string, Record<string, ModelLabFieldValue>>;
  previewChain: (
    audioFile: File,
    adapterIds: { stt: string; llm: string; tts: string },
    values: Record<string, Record<string, ModelLabFieldValue>>
  ) => Promise<ChainPreviewResult>;
}

export function ChainTestPanel({ adapters, buildValues, previewChain }: ChainTestPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ChainPreviewResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const { recording, start, stop, error: recorderError } = useWavRecorder();

  // Revoke audio URL on unmount
  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  // Revoke old audio URL when result changes
  useEffect(() => {
    if (result && result.audioBlob) {
      const newUrl = URL.createObjectURL(result.audioBlob);
      // Revoke old URL if one exists
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
      setAudioUrl(newUrl);
    }
  }, [result]);

  async function handleRecordStart() {
    await start();
  }

  async function handleRecordStop() {
    const recordedFile = await stop();
    if (recordedFile) {
      setFile(recordedFile);
    }
  }

  function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
    }
  }

  async function handleRun() {
    if (running || !file) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const values = buildValues();
      const result = await previewChain(file, adapters as { stt: string; llm: string; tts: string }, values);
      setResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chain preview failed");
    } finally {
      setRunning(false);
    }
  }

  const adaptersMissing =
    adapters.stt === null || adapters.llm === null || adapters.tts === null;

  return (
    <div className={styles.testPanel}>
      <h3 className={styles.testTitle}>Full chain</h3>
      <p className={styles.fieldHelp}>
        Records speech, then runs STT → translation → speech with your current draft settings — the same path a live call takes.
      </p>

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
          <input
            type="file"
            accept="audio/*"
            className={styles.fileInput}
            onChange={handleFileSelect}
          />
        </div>
        {file && (
          <p className={styles.selectedFile}>
            Selected: <span>{file.name}</span>
          </p>
        )}
      </div>

      {recorderError && <p className={styles.errorText}>Microphone unavailable -- check permissions.</p>}

      {adaptersMissing && (
        <p className={styles.errorText}>
          All three adapters (STT, LLM, TTS) must be selected to run the chain preview.
        </p>
      )}

      <Button
        variant="primary"
        loading={running}
        disabled={!file || adaptersMissing}
        onClick={handleRun}
      >
        Run chain
      </Button>

      {error && <p className={styles.errorText}>{error}</p>}

      {result && (
        <div className={styles.chainResultContainer}>
          <div className={styles.chainResultSection}>
            <p className={styles.testResultLabel}>Heard</p>
            <p className={styles.testResultText}>{result.transcript}</p>
          </div>

          <div className={styles.chainResultSection}>
            <div className={styles.chainResultHeader}>
              <p className={styles.testResultLabel}>Translated</p>
              {result.direction && <Badge tone="neutral">{result.direction}</Badge>}
            </div>
            <p className={styles.testResultText}>{result.translatedText}</p>
            {result.tone && <p className={styles.chainResultTone}>{result.tone}</p>}
          </div>

          {audioUrl && (
            <div className={styles.chainResultSection}>
              <p className={styles.testResultLabel}>Audio</p>
              <audio controls src={audioUrl} className={styles.audioPlayer} />
            </div>
          )}

          <div className={styles.chainResultTiming}>
            STT {(result.timing.sttMs / 1000).toFixed(1)}s · LLM {(result.timing.llmMs / 1000).toFixed(1)}s · TTS{" "}
            {(result.timing.ttsMs / 1000).toFixed(1)}s · total {(result.timing.totalMs / 1000).toFixed(1)}s
          </div>
        </div>
      )}
    </div>
  );
}
