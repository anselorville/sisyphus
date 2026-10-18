import { TalkButton } from "../TalkButton";
import { AgentStatusStrip, type AgentActivityState } from "../AgentStatusStrip";
import { TaskNestPanel } from "../TaskNestPanel";
import { TranscriptPanel, type TranscriptEntry } from "../TranscriptPanel";
import { EcologyPanel } from "../EcologyPanel";
import { ElevationDialog, type ElevationRequest } from "../ElevationDialog";
import type { ConnectionState } from "../../../hooks/useAgentConnection";
import type { AgentTask } from "../../../hooks/useAgentTasks";
import type { FoodBand } from "../../../hooks/useEcologyStatus";
import styles from "./AgentHomeScreen.module.css";

export interface AgentHomeScreenProps {
  // Talk control (mirrors TalkButton's own prop needs -- see that
  // component, reused here unmodified).
  connectionState: ConnectionState;
  micLevel: number;
  micOpen: boolean;
  onToggleMic: () => void;

  // Connection toggle (status strip) -- independent of the mic.
  onConnect: () => void;
  onDisconnect: () => void;

  // Status strip
  activity: AgentActivityState;
  statusDetail?: string;

  // Tasks (Scribe-driven ledger, display-only)
  tasks: readonly AgentTask[];

  // Live subtitles (user STT in, agent speech out)
  transcriptEntries: readonly TranscriptEntry[];

  // Ecology / budget
  ecology: FoodBand;
  food: FoodBand;
  sidecarConnected: boolean;

  // Elevation
  elevationRequest: ElevationRequest | null;
  onElevationAllow: (requestId: string) => void;
  onElevationDeny: (requestId: string) => void;
}

/**
 * The app's actual first/default screen: a real voice-assistant home, not a
 * marketing/landing page. Composes the always-visible status strip, the
 * scrollable task/ecology detail area, the main talk control (fixed in its
 * own footer region so list scrolling or status-text length never resizes
 * or moves it), and the elevation dialog overlay when one is pending.
 *
 * Entirely presentational/prop-driven -- every value here is already
 * derived (activity state, task list, ecology bands) rather than raw
 * realtime events, so Storybook fixtures can drive every state directly
 * without needing a live connection or transport.
 */
export function AgentHomeScreen({
  connectionState,
  micLevel,
  onConnect,
  onDisconnect,
  micOpen,
  onToggleMic,
  activity,
  statusDetail,
  tasks,
  transcriptEntries,
  ecology,
  food,
  sidecarConnected,
  elevationRequest,
  onElevationAllow,
  onElevationDeny,
}: AgentHomeScreenProps) {
  return (
    <div className={styles.screen}>
      <AgentStatusStrip
        connectionState={connectionState}
        activity={activity}
        detail={statusDetail}
        ecologyBand={ecology}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />

      <main className={styles.content}>
        <TaskNestPanel tasks={tasks} />
        <TranscriptPanel entries={transcriptEntries} />
        <EcologyPanel ecology={ecology} food={food} sidecarConnected={sidecarConnected} />
      </main>

      <footer className={styles.footer}>
        <TalkButton
          connectionState={connectionState}
          level={micLevel}
          onConnect={onConnect}
          micOpen={micOpen}
          onToggleMic={onToggleMic}
        />
      </footer>

      <ElevationDialog request={elevationRequest} onAllow={onElevationAllow} onDeny={onElevationDeny} />
    </div>
  );
}
