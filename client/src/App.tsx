import { useEffect, useState } from "react";
import { AgentHomeScreen } from "./design-system/components/AgentHomeScreen";
import type { AgentActivityState } from "./design-system/components/AgentStatusStrip";
import type { ElevationRequest } from "./design-system/components/ElevationDialog";
import type { TranscriptEntry } from "./design-system/components/TranscriptPanel";
import { useAgentConnection } from "./hooks/useAgentConnection";
import { useAgentTasks } from "./hooks/useAgentTasks";
import { useEcologyStatus } from "./hooks/useEcologyStatus";
import { useMicLevel } from "./hooks/useMicLevel";
import styles from "./App.module.css";

const ACTIVE_TASK_STATUSES = new Set(["assigned", "running", "blocked"]);
let transcriptSeq = 0;

/**
 * What the agent is doing right now, at a glance -- see
 * AgentStatusStrip.tsx's own doc comment for the priority rationale
 * (hibernating overrides everything; speaking/listening are momentary
 * foreground turn-taking states that outrank the persistent background
 * "working" state; idle is the fallback).
 */
function deriveActivity(flags: {
  hibernating: boolean;
  speaking: boolean;
  listening: boolean;
  working: boolean;
}): AgentActivityState {
  if (flags.hibernating) return "hibernating";
  if (flags.speaking) return "speaking";
  if (flags.listening) return "listening";
  if (flags.working) return "working";
  return "idle";
}

function App() {
  const conn = useAgentConnection();
  const micLevel = useMicLevel(conn.localStream);
  const tasksApi = useAgentTasks();
  const ecologyApi = useEcologyStatus(conn.serverAddress);
  const [elevationRequest, setElevationRequest] = useState<ElevationRequest | null>(null);
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([]);

  // Fans the connection's most recent realtime event out to the task and
  // ecology reducers, plus this component's own small elevation-request
  // slice (not big enough to warrant its own hook file). `conn.lastEvent` is
  // a fresh object on every message (even duplicates), so this effect fires
  // once per message; deduplication and stale/out-of-order handling are the
  // reducers' own job (see useAgentTasks.ts / useEcologyStatus.ts), not this
  // effect's. `tasksApi.dispatch` / `ecologyApi.dispatch` are useReducer
  // dispatchers -- stable identity, safe to leave out of the dependency
  // array without causing missed updates.
  useEffect(() => {
    const event = conn.lastEvent;
    if (!event) return;
    tasksApi.dispatch(event);
    ecologyApi.dispatch(event);
    if (event.type === "user.transcript" || event.type === "agent.transcript") {
      transcriptSeq += 1;
      setTranscriptEntries((prev) => [
        ...prev,
        {
          id: transcriptSeq,
          speaker: event.type === "user.transcript" ? "user" : "agent",
          text: event.text,
          timestamp: Date.now(),
        },
      ]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.lastEvent]);

  const activeTaskCount = tasksApi.tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length;
  const activity = deriveActivity({
    hibernating: ecologyApi.ecology === "hibernating" || ecologyApi.food === "hibernating",
    speaking: conn.isSpeaking,
    listening: conn.micOpen,
    working: activeTaskCount > 0,
  });
  const statusDetail = activeTaskCount > 0 ? `${activeTaskCount} task${activeTaskCount === 1 ? "" : "s"} running` : undefined;

  return (
    <div className={styles.root}>
      <AgentHomeScreen
        connectionState={conn.connectionState}
        micLevel={micLevel}
        onConnect={conn.connect}
        onDisconnect={conn.disconnect}
        micOpen={conn.micOpen}
        onToggleMic={() => conn.setMicOpen(!conn.micOpen)}
        activity={activity}
        statusDetail={statusDetail}
        tasks={tasksApi.tasks}
        transcriptEntries={transcriptEntries}
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
    </div>
  );
}

export default App;
