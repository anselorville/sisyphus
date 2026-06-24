import { useState } from "react";
import { AppShell } from "./design-system/layouts/AppShell";
import { TranscriptLog } from "./design-system/components/TranscriptLog";
import { ConnectButton } from "./design-system/components/ConnectButton";
import { AudioLevelMeter } from "./design-system/components/AudioLevelMeter";
import { SettingsPanel } from "./design-system/components/SettingsPanel";
import { useTranslatorConnection } from "./hooks/useTranslatorConnection";
import { useMicLevel } from "./hooks/useMicLevel";
import styles from "./App.module.css";

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

  return (
    <div className={styles.root}>
      <AppShell
        title="Sisyphus Translator"
        connectionState={connectionState}
        onSettingsClick={() => setSettingsOpen((open) => !open)}
        footer={
          <>
            <ConnectButton connectionState={connectionState} onConnect={connect} onDisconnect={disconnect} />
            <AudioLevelMeter level={micLevel} />
          </>
        }
      >
        <TranscriptLog entries={transcripts} />
      </AppShell>
      {settingsOpen && (
        <div className={styles.settingsOverlay}>
          <SettingsPanel
            serverAddress={serverAddress}
            onServerAddressChange={setServerAddress}
            connectionState={connectionState}
            onClose={() => setSettingsOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

export default App;
