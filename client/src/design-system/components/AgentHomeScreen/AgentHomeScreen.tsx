import { TalkButton } from "../TalkButton";
import { AgentStatusStrip, type AgentActivityState } from "../AgentStatusStrip";
import { TaskNestPanel } from "../TaskNestPanel";
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
  onConnect: () => void;
  onDisconnect: () => void;
  manualTurnMode: boolean;
  micOpen: boolean;
  onToggleMic: () => void;

  // Status strip
  activity: AgentActivityState;
  statusDetail?: string;

  // Tasks
  tasks: readonly AgentTask[];
  onCancelTask: (taskId: string) => void;
  onSteerTask: (taskId: string, text: string) => void;
  onFollowUpTask: (taskId: string, text: string) => void;

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
  manualTurnMode,
  micOpen,
  onToggleMic,
  activity,
  statusDetail,
  tasks,
  onCancelTask,
  onSteerTask,
  onFollowUpTask,
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
      />

      <main className={styles.content}>
        <TaskNestPanel tasks={tasks} onCancel={onCancelTask} onSteer={onSteerTask} onFollowUp={onFollowUpTask} />
        <EcologyPanel ecology={ecology} food={food} sidecarConnected={sidecarConnected} />
      </main>

      <footer className={styles.footer}>
        <TalkButton
          connectionState={connectionState}
          level={micLevel}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          manualTurnMode={manualTurnMode}
          micOpen={micOpen}
          onToggleMic={onToggleMic}
        />
      </footer>

      <ElevationDialog request={elevationRequest} onAllow={onElevationAllow} onDeny={onElevationDeny} />
    </div>
  );
}
