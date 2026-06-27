import { useCallback, useState } from "react";
import { Rows2 } from "lucide-react";
import { TranscriptLog } from "./design-system/components/TranscriptLog";
import { TalkButton } from "./design-system/components/TalkButton";
import { LanguagePairHeader } from "./design-system/components/LanguagePairHeader";
import { ConnectionStatusBadge } from "./design-system/components/ConnectionStatusBadge";
import { SettingsScreen } from "./design-system/components/SettingsScreen";
import { ModelLabScreen } from "./design-system/components/ModelLabScreen";
import { FaceToFaceView } from "./design-system/components/FaceToFaceView";
import { EmptyState } from "./design-system/components/EmptyState";
import type { EngineMode } from "./design-system/components/EngineStatusChip";
import { LANGUAGES, type LanguageOption } from "./data/languages";
import { useTranslatorConnection } from "./hooks/useTranslatorConnection";
import { useMicLevel } from "./hooks/useMicLevel";
import type { ServerStatus } from "./hooks/useTranslatorConnection.types";
import styles from "./App.module.css";

// Maps the server's `/api/status` "engine" value (one of "cloud"/"offline"/
// "omlx") to EngineStatusChip's prop type. "omlx" -> "local-dev" since it's
// the Mac-only local dev/test engine. Falls back to "unknown" if the status
// hasn't loaded yet (or the fetch failed).
function engineModeFromStatus(status: ServerStatus | null): EngineMode {
  if (!status) return "unknown";
  if (status.engine === "omlx") return "local-dev";
  return status.engine;
}

const DEFAULT_SOURCE = LANGUAGES.find((lang) => lang.code === "ZH")!;
const DEFAULT_TARGET = LANGUAGES.find((lang) => lang.code === "EN")!;

function App() {
  const {
    connectionState,
    transcripts,
    serverAddress,
    setServerAddress,
    localStream,
    serverStatus,
    connect,
    disconnect,
  } = useTranslatorConnection();
  const micLevel = useMicLevel(localStream);
  const engineMode = engineModeFromStatus(serverStatus);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelLabOpen, setModelLabOpen] = useState(false);
  const [faceToFaceOpen, setFaceToFaceOpen] = useState(false);
  const [source, setSource] = useState<LanguageOption>(DEFAULT_SOURCE);
  const [target, setTarget] = useState<LanguageOption>(DEFAULT_TARGET);

  const handleSwap = useCallback(() => {
    setSource(target);
    setTarget(source);
  }, [source, target]);

  // Settings, Model Lab, and face-to-face are mutually exclusive full-screen modes.
  const openSettings = useCallback(() => {
    setFaceToFaceOpen(false);
    setModelLabOpen(false);
    setSettingsOpen(true);
  }, []);
  const openModelLab = useCallback(() => {
    setSettingsOpen(false);
    setModelLabOpen(true);
  }, []);
  const toggleFaceToFace = useCallback(() => {
    setSettingsOpen(false);
    setModelLabOpen(false);
    setFaceToFaceOpen((open) => !open);
  }, []);

  if (modelLabOpen) {
    return (
      <div className={styles.root}>
        <ModelLabScreen
          serverAddress={serverAddress}
          engineMode={engineMode}
          onClose={() => {
            setModelLabOpen(false);
            setSettingsOpen(true);
          }}
        />
      </div>
    );
  }

  if (settingsOpen) {
    return (
      <div className={styles.root}>
        <SettingsScreen
          source={source}
          target={target}
          onSourceChange={setSource}
          onTargetChange={setTarget}
          serverAddress={serverAddress}
          onServerAddressChange={setServerAddress}
          connectionState={connectionState}
          engineMode={engineMode}
          onClose={() => setSettingsOpen(false)}
          onOpenModelLab={openModelLab}
        />
      </div>
    );
  }

  if (faceToFaceOpen) {
    return (
      <div className={styles.root}>
        <FaceToFaceView
          source={source}
          target={target}
          transcripts={transcripts}
          connectionState={connectionState}
          onExit={() => setFaceToFaceOpen(false)}
        />
      </div>
    );
  }

  const showEmptyState = transcripts.length === 0;
  const emptyVariant = connectionState === "connecting" ? "connecting" : connectionState === "error" ? "error" : "welcome";

  return (
    <div className={styles.root}>
      <div className={styles.shell}>
        <LanguagePairHeader
          source={source}
          target={target}
          onSwap={handleSwap}
          onSettingsClick={openSettings}
          statusSlot={<ConnectionStatusBadge connectionState={connectionState} />}
        />

        <main className={styles.content}>
          {showEmptyState ? (
            <EmptyState variant={emptyVariant} />
          ) : (
            <TranscriptLog entries={transcripts} />
          )}
        </main>

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.faceToFaceButton}
            onClick={toggleFaceToFace}
            aria-label="Switch to face-to-face mode"
            title="Face-to-face mode"
          >
            <Rows2 size={18} />
          </button>
          <TalkButton
            connectionState={connectionState}
            level={micLevel}
            onConnect={connect}
            onDisconnect={disconnect}
          />
          <span className={styles.footerSpacer} aria-hidden="true" />
        </footer>
      </div>
    </div>
  );
}

export default App;
