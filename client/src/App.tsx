import { useCallback, useEffect, useRef, useState } from "react";
import { Power, Rows2 } from "lucide-react";
import { TranscriptLog } from "./design-system/components/TranscriptLog";
import { TalkButton } from "./design-system/components/TalkButton";
import { LanguagePairHeader } from "./design-system/components/LanguagePairHeader";
import { ConnectionStatusBadge } from "./design-system/components/ConnectionStatusBadge";
import { SettingsScreen } from "./design-system/components/SettingsScreen";
import { ModelLabScreen } from "./design-system/components/ModelLabScreen";
import { ModelProviderScreen } from "./design-system/components/ModelProviderScreen";
import { FaceToFaceView } from "./design-system/components/FaceToFaceView";
import { EmptyState } from "./design-system/components/EmptyState";
import type { EngineMode } from "./design-system/components/EngineStatusChip";
import { LANGUAGES, type LanguageOption } from "./data/languages";

type ConversationMode = "translator" | "assistant";
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
    micOpen,
    setMicOpen,
  } = useTranslatorConnection();
  const micLevel = useMicLevel(localStream);
  const engineMode = engineModeFromStatus(serverStatus);
  // Manual (mic-button) turn mode unless the server explicitly runs "auto"
  // -- mirrors the hook's own default; see app/config.py TURN_MODE.
  const manualTurnMode = serverStatus?.turn_mode !== "auto";

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelLabOpen, setModelLabOpen] = useState(false);
  const [modelProviderOpen, setModelProviderOpen] = useState(false);
  const [faceToFaceOpen, setFaceToFaceOpen] = useState(false);
  const [source, setSource] = useState<LanguageOption>(DEFAULT_SOURCE);
  const [target, setTarget] = useState<LanguageOption>(DEFAULT_TARGET);
  const [conversationMode, setConversationMode] = useState<ConversationMode>("translator");

  // Connect with the CURRENT language pair and mode -- the picker is the
  // authority for what this conversation does.
  const connectWithLanguages = useCallback(
    () => connect({ source: source.envValue, target: target.envValue, mode: conversationMode }),
    [connect, source, target, conversationMode]
  );

  // The pipeline's language pair is fixed at connection build time, so a
  // language change while connected silently keeps translating the OLD pair
  // -- exactly the "I switched the language but it still speaks English"
  // trap. Reconnecting immediately makes the picker behave as expected.
  const languagesRef = useRef({ source: source.envValue, target: target.envValue, mode: conversationMode });
  useEffect(() => {
    const changed =
      languagesRef.current.source !== source.envValue ||
      languagesRef.current.target !== target.envValue ||
      languagesRef.current.mode !== conversationMode;
    languagesRef.current = { source: source.envValue, target: target.envValue, mode: conversationMode };
    if (changed && connectionState === "connected") {
      disconnect();
      const timer = setTimeout(() => {
        connect({ source: source.envValue, target: target.envValue, mode: conversationMode });
      }, 300);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, target, conversationMode]);

  const handleSwap = useCallback(() => {
    setSource(target);
    setTarget(source);
  }, [source, target]);

  // Settings, Model Lab, Model Provider, and face-to-face are mutually exclusive full-screen modes.
  const openSettings = useCallback(() => {
    setFaceToFaceOpen(false);
    setModelLabOpen(false);
    setModelProviderOpen(false);
    setSettingsOpen(true);
  }, []);
  const openModelLab = useCallback(() => {
    setSettingsOpen(false);
    setModelLabOpen(true);
  }, []);
  const openModelProvider = useCallback(() => {
    setSettingsOpen(false);
    setModelProviderOpen(true);
  }, []);
  const toggleFaceToFace = useCallback(() => {
    setSettingsOpen(false);
    setModelLabOpen(false);
    setModelProviderOpen(false);
    setFaceToFaceOpen((open) => !open);
  }, []);

  if (modelLabOpen) {
    return (
      <div className={styles.root}>
        <ModelLabScreen
          serverAddress={serverAddress}
          onClose={() => {
            setModelLabOpen(false);
            setSettingsOpen(true);
          }}
        />
      </div>
    );
  }

  if (modelProviderOpen) {
    return (
      <div className={styles.root}>
        <ModelProviderScreen
          serverAddress={serverAddress}
          onClose={() => {
            setModelProviderOpen(false);
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
          conversationMode={conversationMode}
          onConversationModeChange={setConversationMode}
          serverAddress={serverAddress}
          onServerAddressChange={setServerAddress}
          connectionState={connectionState}
          engineMode={engineMode}
          onClose={() => setSettingsOpen(false)}
          onOpenModelLab={openModelLab}
          onOpenModelProvider={openModelProvider}
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
          manualTurnMode={manualTurnMode}
          micOpen={micOpen}
          onToggleMic={() => setMicOpen(!micOpen)}
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
          statusSlot={
            <span className={styles.statusCluster}>
              <ConnectionStatusBadge connectionState={connectionState} />
              {manualTurnMode && (
                <button
                  type="button"
                  className={styles.serviceToggle}
                  data-active={connectionState === "connected"}
                  onClick={connectionState === "connected" ? disconnect : connectWithLanguages}
                  disabled={connectionState === "connecting"}
                  aria-label={connectionState === "connected" ? "Stop voice service" : "Start voice service"}
                  title={connectionState === "connected" ? "Stop voice service" : "Start voice service"}
                >
                  <Power size={16} />
                </button>
              )}
            </span>
          }
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
            onConnect={connectWithLanguages}
            onDisconnect={disconnect}
            manualTurnMode={manualTurnMode}
            micOpen={micOpen}
            onToggleMic={() => setMicOpen(!micOpen)}
          />
          <span className={styles.footerSpacer} aria-hidden="true" />
        </footer>
      </div>
    </div>
  );
}

export default App;
