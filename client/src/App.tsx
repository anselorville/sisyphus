import { useCallback, useState } from "react";
import { Rows2 } from "lucide-react";
import { TranscriptLog } from "./design-system/components/TranscriptLog";
import { TalkButton } from "./design-system/components/TalkButton";
import { LanguagePairHeader } from "./design-system/components/LanguagePairHeader";
import { ConnectionStatusBadge } from "./design-system/components/ConnectionStatusBadge";
import { SettingsScreen } from "./design-system/components/SettingsScreen";
import { FaceToFaceView } from "./design-system/components/FaceToFaceView";
import { EmptyState } from "./design-system/components/EmptyState";
import type { EngineMode } from "./design-system/components/EngineStatusChip";
import { LANGUAGES, type LanguageOption } from "./data/languages";
import { useTranslatorConnection } from "./hooks/useTranslatorConnection";
import { useMicLevel } from "./hooks/useMicLevel";
import styles from "./App.module.css";

// Backend does not yet expose which translation engine is active (cloud API
// vs. offline Pi-portable fallback vs. local oMLX dev path) -- see
// EngineStatusChip's doc comment. Hardcoded until that endpoint exists.
const STATIC_ENGINE_MODE: EngineMode = "unknown";

const DEFAULT_SOURCE = LANGUAGES.find((lang) => lang.code === "ZH")!;
const DEFAULT_TARGET = LANGUAGES.find((lang) => lang.code === "EN")!;

function App() {
  const {
    connectionState,
    transcripts,
    serverAddress,
    setServerAddress,
    localStream,
    connect,
    disconnect,
  } = useTranslatorConnection();
  const micLevel = useMicLevel(localStream);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [faceToFaceOpen, setFaceToFaceOpen] = useState(false);
  const [source, setSource] = useState<LanguageOption>(DEFAULT_SOURCE);
  const [target, setTarget] = useState<LanguageOption>(DEFAULT_TARGET);

  const handleSwap = useCallback(() => {
    setSource(target);
    setTarget(source);
  }, [source, target]);

  // Settings and face-to-face are mutually exclusive full-screen modes.
  const openSettings = useCallback(() => {
    setFaceToFaceOpen(false);
    setSettingsOpen(true);
  }, []);
  const toggleFaceToFace = useCallback(() => {
    setSettingsOpen(false);
    setFaceToFaceOpen((open) => !open);
  }, []);

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
          engineMode={STATIC_ENGINE_MODE}
          onClose={() => setSettingsOpen(false)}
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
