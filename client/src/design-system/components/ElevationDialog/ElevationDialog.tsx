import { ShieldAlert } from "lucide-react";
import { Button } from "../../primitives/Button";
import styles from "./ElevationDialog.module.css";

/**
 * Shape carried by the sidecar's `diplomacy.elevation.requested` event (see
 * agent-runtime/src/tools/capability-gateway.ts's `PendingElevationRequest`/
 * `ElevationRequiredError`, and the wire-shape extension documented in
 * useAgentConnection.ts). `action`/`impact` are the same two fields
 * agent-runtime/src/voice/voice-herald.ts's buildElevationRequestText()
 * interpolates into its spoken template ("准备执行{action}，可能影响{impact}，
 * 是否允许？") -- this dialog is the visual counterpart of that same prompt.
 */
export interface ElevationRequest {
  readonly requestId: string;
  readonly action: string;
  readonly impact: string;
  readonly taskId?: string;
}

export interface ElevationDialogProps {
  /** `null` means nothing is pending -- renders nothing. */
  request: ElevationRequest | null;
  onAllow: (requestId: string) => void;
  onDeny: (requestId: string) => void;
}

/**
 * Modal confirmation for a paused, elevation-required action. The card's
 * body (action/impact text) scrolls independently of its footer, so however
 * long that text gets, the Allow/Deny buttons stay pinned and visible --
 * never obscured, never pushed off-card.
 */
export function ElevationDialog({ request, onAllow, onDeny }: ElevationDialogProps) {
  if (!request) return null;

  return (
    <div className={styles.overlay} role="presentation">
      <div
        className={styles.card}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="elevation-dialog-title"
        aria-describedby="elevation-dialog-body"
      >
        <div className={styles.body}>
          <span className={styles.icon}>
            <ShieldAlert size={28} strokeWidth={1.5} />
          </span>
          <h2 id="elevation-dialog-title" className={styles.title}>
            Permission needed
          </h2>
          <div id="elevation-dialog-body" className={styles.text}>
            <p>
              <strong>About to do:</strong> {request.action}
            </p>
            <p>
              <strong>May affect:</strong> {request.impact}
            </p>
          </div>
        </div>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => onDeny(request.requestId)}>
            Deny
          </Button>
          <Button variant="primary" onClick={() => onAllow(request.requestId)}>
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}
