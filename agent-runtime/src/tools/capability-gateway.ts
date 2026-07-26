/**
 * Capability Gateway: the single choke point every external tool call must
 * pass through before it actually executes anything against the real world
 * -- file writes, terminal commands, emails, web requests, device actions,
 * ... (the concrete tools that call in here are a later task; this module
 * only builds the gate itself).
 *
 * execute() always asks the injected DiplomacyEvaluator (in production, a
 * DiplomacyOfficer -- see ./diplomacy-officer.ts) for a decision before
 * running anything:
 *   - ALLOW: run the operation, return its result. Nothing else happens.
 *   - ALLOW_LOGGED: run the operation, then durably record its target,
 *     impact, and (when derivable) a recovery note, then return the result.
 *   - ELEVATE: the operation never runs. A one-time, target-scoped
 *     authorization request is created and persisted, and execute() rejects
 *     with ElevationRequiredError instead of resolving -- a caller can never
 *     mistake a paused action for a completed one.
 *
 * A pending elevation is authorized via approve(requestId, target), which is
 * intentionally narrow: it authorizes exactly one future execute() call
 * whose envelope's targetSummary matches `target`, and is consumed
 * (single-use) the moment that call goes through. Approving request A for
 * target "X" never authorizes a call against target "Y", and never expands
 * into a role's standing permissions -- see
 * .proj-init/04-autonomous-swarm-voice-agent-software-design.md section 9.4.
 *
 * Persistence shape (a deliberate, documented choice -- the spec leaves this
 * open): pending requests, approvals, and the durable log are held in this
 * instance's own memory, which is exactly as durable as the sidecar process.
 * `onLog` / `onElevationRequested` / `onElevationResolved` are optional
 * hooks (same shape as RuntimeMetricsOptions.onSample/onPersistError in
 * ../telemetry/runtime-metrics.ts) that a later task can wire to real SQLite
 * persistence (../storage/database.ts) and to the
 * `diplomacy.elevation.requested` / `diplomacy.elevation.resolved` realtime
 * events (../protocol/events.ts) without touching this file again.
 */

import { randomUUID } from "node:crypto";

import type { ActionEnvelope, ActionOperation, DiplomacyDecision } from "./diplomacy-officer.js";

/** Structural seam a real DiplomacyOfficer satisfies as-is; tests inject a fake instead of the real rule cascade -- mirrors PiSessionProvider in ../roles/types.ts. */
export interface DiplomacyEvaluator {
  evaluate(envelope: ActionEnvelope): Promise<DiplomacyDecision>;
}

/** Durable record of one ALLOW_LOGGED action, or one previously-ELEVATEd action that ran after an approval was consumed. */
export interface DiplomacyLogEntry {
  readonly taskId: string;
  readonly roleId: string;
  readonly toolName: string;
  readonly target: string;
  readonly operation: ActionOperation;
  readonly decision: "ALLOW_LOGGED" | "ELEVATE";
  readonly impact: string;
  /** Present only when derivable from the envelope's own fields (see deriveRecoveryNote) -- never fabricated. */
  readonly recoveryNote: string | undefined;
  readonly recordedAt: string;
}

/** A one-time authorization request, created the moment an action is first classified ELEVATE. */
export interface PendingElevationRequest {
  readonly requestId: string;
  readonly target: string;
  readonly envelope: ActionEnvelope;
  readonly createdAt: string;
}

export interface ElevationApprovalRecord {
  readonly requestId: string;
  readonly target: string;
  readonly approvedAt: string;
  readonly expiresAt: string | undefined;
}

/**
 * Rejected with instead of resolving whenever ELEVATE blocks execution --
 * whether this is the very first time this target was seen, the approval
 * expired, or an approval exists but for a different target. Carries the
 * pending request so a caller (or a human-approval flow) can retrieve
 * `requestId`/`target` and eventually call approve().
 */
export class ElevationRequiredError extends Error {
  readonly requestId: string;
  readonly target: string;
  readonly request: PendingElevationRequest;

  constructor(request: PendingElevationRequest) {
    super(
      `elevation required for target "${request.target}" (request ${request.requestId}): action paused pending one-time authorization`,
    );
    this.name = "ElevationRequiredError";
    this.requestId = request.requestId;
    this.target = request.target;
    this.request = request;
  }
}

export interface CapabilityGatewayOptions {
  readonly officer: DiplomacyEvaluator;
  /** How long an approval stays consumable after approve(). Default 5 minutes; 0 disables expiry. */
  readonly elevationTtlMs?: number;
  readonly now?: () => Date;
  /** Test/observability hook: called with every durable log entry, after it is recorded. */
  readonly onLog?: (entry: DiplomacyLogEntry) => void | Promise<void>;
  /** Called the moment a brand-new pending elevation request is created -- the natural hook point for emitting `diplomacy.elevation.requested`. */
  readonly onElevationRequested?: (request: PendingElevationRequest) => void | Promise<void>;
  /** Called when approve() records a new approval -- the hook point for `diplomacy.elevation.resolved`. */
  readonly onElevationResolved?: (approval: ElevationApprovalRecord) => void | Promise<void>;
}

const DEFAULT_ELEVATION_TTL_MS = 5 * 60 * 1000;

interface StoredApproval {
  readonly requestId: string;
  readonly target: string;
  readonly approvedAt: string;
  readonly expiresAtMs: number | undefined;
  consumed: boolean;
}

export class CapabilityGateway {
  private readonly officer: DiplomacyEvaluator;
  private readonly elevationTtlMs: number;
  private readonly now: () => Date;
  private readonly onLog: (entry: DiplomacyLogEntry) => void | Promise<void>;
  private readonly onElevationRequested: (request: PendingElevationRequest) => void | Promise<void>;
  private readonly onElevationResolved: (approval: ElevationApprovalRecord) => void | Promise<void>;

  /** Currently-open (not yet resolved by a consumed approval) elevation requests, keyed by requestId. */
  private readonly pendingRequests = new Map<string, PendingElevationRequest>();
  /** Every approval ever recorded via approve(), oldest first; consumed in place (never removed) so an attempted reuse is still observable. */
  private readonly approvals: StoredApproval[] = [];
  private readonly logs: DiplomacyLogEntry[] = [];

  constructor(options: CapabilityGatewayOptions) {
    this.officer = options.officer;
    this.elevationTtlMs = options.elevationTtlMs ?? DEFAULT_ELEVATION_TTL_MS;
    this.now = options.now ?? ((): Date => new Date());
    this.onLog = options.onLog ?? ((): void => {});
    this.onElevationRequested = options.onElevationRequested ?? ((): void => {});
    this.onElevationResolved = options.onElevationResolved ?? ((): void => {});
  }

  /** Durable log entries recorded so far, oldest first. Read-only (see the module doc comment on persistence shape). */
  get logEntries(): readonly DiplomacyLogEntry[] {
    return this.logs;
  }

  /** Currently-open, not-yet-resolved elevation requests. Read-only. */
  get pendingElevations(): readonly PendingElevationRequest[] {
    return [...this.pendingRequests.values()];
  }

  /**
   * The single choke point: nothing this returns can be mistaken for a
   * completed action unless `operation` genuinely ran. ELEVATE always
   * rejects (ElevationRequiredError) rather than resolving with a pending
   * placeholder, so a caller that forgets to inspect a result shape can
   * never accidentally treat a paused action as done.
   */
  async execute<T>(envelope: ActionEnvelope, operation: () => Promise<T>): Promise<T> {
    const decision = await this.officer.evaluate(envelope);

    if (decision === "ALLOW") {
      return operation();
    }

    if (decision === "ALLOW_LOGGED") {
      const result = await operation();
      await this.recordLog(envelope, "ALLOW_LOGGED");
      return result;
    }

    // Fail-safe: anything other than ALLOW/ALLOW_LOGGED (i.e. ELEVATE, or --
    // defensively -- any unexpected value) is treated as ELEVATE. Never fail
    // open.
    return this.executeElevated(envelope, operation);
  }

  /**
   * Marks `requestId` approved for exactly `target`. Intentionally does not
   * require a matching pending request to already exist in this gateway's
   * own in-memory store -- the pending-elevation persistence shape is a
   * deliberate, documented design choice (see the module doc comment), and
   * the real single-use guarantee lives entirely on the *consuming* side:
   * execute() only ever honors an approval whose `target` exactly equals
   * the envelope's own targetSummary, and only once (see executeElevated()).
   */
  async approve(requestId: string, target: string): Promise<ElevationApprovalRecord> {
    const approvedAt = this.now().toISOString();
    const expiresAtMs = this.elevationTtlMs > 0 ? this.now().getTime() + this.elevationTtlMs : undefined;
    this.approvals.push({ requestId, target, approvedAt, expiresAtMs, consumed: false });

    const record: ElevationApprovalRecord = {
      requestId,
      target,
      approvedAt,
      expiresAt: expiresAtMs !== undefined ? new Date(expiresAtMs).toISOString() : undefined,
    };
    await this.onElevationResolved(record);
    return record;
  }

  private async executeElevated<T>(envelope: ActionEnvelope, operation: () => Promise<T>): Promise<T> {
    const target = envelope.targetSummary;
    const approval = this.consumeMatchingApproval(target);

    if (approval) {
      const result = await operation();
      this.clearPendingRequestsForTarget(target);
      await this.recordLog(envelope, "ELEVATE");
      return result;
    }

    const request: PendingElevationRequest = {
      requestId: randomUUID(),
      target,
      envelope,
      createdAt: this.now().toISOString(),
    };
    this.pendingRequests.set(request.requestId, request);
    await this.onElevationRequested(request);
    throw new ElevationRequiredError(request);
  }

  /** Finds the first unconsumed, unexpired approval for `target` and marks it consumed atomically (single-use, synchronous so no other call can interleave). Returns undefined (consuming nothing) if none match. */
  private consumeMatchingApproval(target: string): StoredApproval | undefined {
    const nowMs = this.now().getTime();
    const match = this.approvals.find(
      (approval) =>
        approval.target === target &&
        !approval.consumed &&
        (approval.expiresAtMs === undefined || approval.expiresAtMs > nowMs),
    );
    if (!match) {
      return undefined;
    }
    match.consumed = true;
    return match;
  }

  private clearPendingRequestsForTarget(target: string): void {
    for (const [requestId, request] of this.pendingRequests) {
      if (request.target === target) {
        this.pendingRequests.delete(requestId);
      }
    }
  }

  private async recordLog(envelope: ActionEnvelope, decision: "ALLOW_LOGGED" | "ELEVATE"): Promise<void> {
    const entry: DiplomacyLogEntry = {
      taskId: envelope.taskId,
      roleId: envelope.roleId,
      toolName: envelope.toolName,
      target: envelope.targetSummary,
      operation: envelope.operation,
      decision,
      impact: describeImpact(envelope),
      recoveryNote: deriveRecoveryNote(envelope),
      recordedAt: this.now().toISOString(),
    };
    this.logs.push(entry);
    await this.onLog(entry);
  }
}

function describeImpact(envelope: ActionEnvelope): string {
  const parts = [
    `${envelope.operation} on "${envelope.targetSummary}"`,
    `${envelope.affectedObjects} object(s) affected`,
  ];
  if (envelope.externalAudience > 0) {
    parts.push(`reaches ${envelope.externalAudience} external recipient(s)`);
  }
  if (envelope.sensitiveData) {
    parts.push("involves sensitive data");
  }
  return parts.join("; ");
}

/** Only ever derived from the envelope's own structured fields -- never fabricated. Undefined when the envelope doesn't give us enough to say anything concrete (i.e. it isn't reversible). */
function deriveRecoveryNote(envelope: ActionEnvelope): string | undefined {
  if (!envelope.reversible) {
    return undefined;
  }
  return `reversible: "${envelope.operation}" on "${envelope.targetSummary}" can likely be undone or restored`;
}
