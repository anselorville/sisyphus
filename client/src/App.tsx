import { useState } from "react";
import { AgentHomeScreen } from "./design-system/components/AgentHomeScreen";
import { ModelLabScreen } from "./design-system/components/ModelLabScreen";
import { ModelProviderScreen } from "./design-system/components/ModelProviderScreen";
import { SettingsScreen } from "./design-system/components/SettingsScreen";
import type { AgentActivityState } from "./design-system/components/AgentStatusStrip";
import type { ElevationRequest } from "./design-system/components/ElevationDialog";
import type { TranscriptEntry } from "./design-system/components/TranscriptPanel";
import { useAgentConnection, type AgentWireEvent } from "./hooks/useAgentConnection";
import { useAgentTasks } from "./hooks/useAgentTasks";
import { useEcologyStatus } from "./hooks/useEcologyStatus";
import { useEngineMode } from "./hooks/useEngineMode";
import { useAudioLevel } from "./hooks/useAudioLevel";
import { deriveVoicePhase, useVoiceSession, type VoicePhase } from "./hooks/useVoiceSession";
import styles from "./App.module.css";

/** Screens layered over the home screen; "home" means none is open. */
type Screen = "home" | "settings" | "model-lab" | "model-provider";

const ACTIVE_TASK_STATUSES = new Set(["assigned", "running", "blocked"]);
let transcriptSeq = 0;

/**
 * What the agent is doing right now, at a glance -- see
 * AgentStatusStrip.tsx's own doc comment for the priority rationale
 * (hibernating overrides everything; the foreground turn-taking phases
 * outrank the persistent background "working" state; idle is the fallback).
 */
function deriveActivity(flags: { hibernating: boolean; phase: VoicePhase; working: boolean }): AgentActivityState {
  if (flags.hibernating) return "hibernating";
  if (flags.phase === "speaking") return "speaking";
  if (flags.phase === "listening") return "listening";
  if (flags.phase === "thinking") return "thinking";
  if (flags.working) return "working";
  return "idle";
}

function App() {
  const conn = useAgentConnection((event) => handleEvent(event));
  const micLevel = useAudioLevel(conn.localStream);
  const agentLevel = useAudioLevel(conn.remoteStream);
  const voice = useVoiceSession(conn.connectionState);
  const tasksApi = useAgentTasks();
  const ecologyApi = useEcologyStatus(conn.serverAddress);
  const [elevationRequest, setElevationRequest] = useState<ElevationRequest | null>(null);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);
  const [screen, setScreen] = useState<Screen>("home");
  const engineMode = useEngineMode(conn.serverAddress, screen === "settings");

  // Called by the connection once per realtime event, in arrival order (see
  // useAgentConnection's onEvent). Fans each event out to the voice, task
  // and ecology reducers -- each ignores types it doesn't handle and owns
  // its own deduplication -- plus this component's small transcript and
  // elevation-request slices.
  function handleEvent(event: AgentWireEvent) {
    voice.dispatch(event);
    tasksApi.dispatch(event);
    ecologyApi.dispatch(event);
    if (event.type === "user.transcript" || event.type === "agent.transcript") {
      transcriptSeq += 1;
      const entry: TranscriptEntry = {
        id: transcriptSeq,
        speaker: event.type === "user.transcript" ? "user" : "agent",
        text: event.text,
        timestamp: Date.now(),
      };
      setTranscriptEntries((prev) => [...prev, entry]);
    } else if (event.type === "diplomacy.elevation.requested") {
      setElevationRequest({
        requestId: event.request_id,
        action: event.action ?? "an action",
        impact: event.impact ?? "an uncertain scope",
        taskId: event.task_id,
      });
    } else if (event.type === "diplomacy.elevation.resolved") {
      setElevationRequest((current) => (current?.requestId === event.request_id ? null : current));
    }
  }

  const phase = deriveVoicePhase({ connectionState: conn.connectionState, micOpen: conn.micOpen, session: voice });
  const activeTaskCount = tasksApi.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length;
  const activity = deriveActivity({
    hibernating: ecologyApi.ecology === "hibernating" || ecologyApi.food === "hibernating",
    phase,
    working: activeTaskCount > 0,
  });
  const statusDetail = activeTaskCount > 0 ? `${activeTaskCount} task${activeTaskCount === 1 ? "" : "s"} running` : undefined;

  return (
    <div className={styles.root}>
      <AgentHomeScreen
        connectionState={conn.connectionState}
        micLevel={phase === "speaking" ? agentLevel : micLevel}
        agentSpeaking={phase === "speaking"}
        onConnect={conn.connect}
        onDisconnect={conn.disconnect}
        onOpenSettings={() => setScreen("settings")}
        micOpen={conn.micOpen}
        onToggleMic={() => conn.setMicOpen(!conn.micOpen)}
        activity={activity}
        statusDetail={statusDetail}
        tasks={tasksApi.tasks}
        transcriptEntries={transcriptEntries}
        pendingUserText={voice.partialText}
        ecology={ecologyApi.ecology}
        food={ecologyApi.food}
        sidecarConnected={ecologyApi.sidecarConnected}
        elevationRequest={elevationRequest}
        onElevationAllow={(requestId) => {
          conn.sendControl({ type: "elevation.response", request_id: requestId, allow: true });
          setElevationRequest(null);
        }}
        onElevationDeny={(requestId) => {
          conn.sendControl({ type: "elevation.response", request_id: requestId, allow: false });
          setElevationRequest(null);
        }}
      />

      {/* Sub-screens cover the home screen instead of replacing it, so the
          live session (connection, transcript, tasks) keeps running
          underneath. The elevation dialog (z-index 100) stays above them. */}
      {screen !== "home" && (
        <div className={styles.overlay}>
          {screen === "settings" && (
            <SettingsScreen
              serverAddress={conn.serverAddress}
              onServerAddressChange={conn.setServerAddress}
              connectionState={conn.connectionState}
              engineMode={engineMode}
              onClose={() => setScreen("home")}
              onOpenModelLab={() => setScreen("model-lab")}
              onOpenModelProvider={() => setScreen("model-provider")}
            />
          )}
          {screen === "model-lab" && (
            <ModelLabScreen serverAddress={conn.serverAddress} onClose={() => setScreen("settings")} />
          )}
          {screen === "model-provider" && (
            <ModelProviderScreen serverAddress={conn.serverAddress} onClose={() => setScreen("settings")} />
          )}
        </div>
      )}
    </div>
  );
}

export default App;
