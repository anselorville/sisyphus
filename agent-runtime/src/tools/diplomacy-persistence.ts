/**
 * Wires CapabilityGateway's onLog/onElevationRequested/onElevationResolved
 * hooks (./capability-gateway.ts) to real SQLite persistence and (for the
 * two hooks with a defined wire event type) the realtime event bus --
 * closes the "CapabilityGateway persistence" gap named in ../README.md's
 * roadmap. Kept in its own file rather than inline in ../index.ts, mirroring
 * ../tasks/inbound-event-router.ts's own stated reason: no business logic
 * belongs in the composition root.
 *
 * `onLog` persists every ALLOW_LOGGED/ELEVATE decision to `diplomacy_log`.
 * `onElevationRequested`/`onElevationResolved` persist to
 * `diplomacy_pending_elevations`/`diplomacy_elevation_approvals` AND
 * broadcast the already-defined `diplomacy.elevation.requested`/`resolved`
 * RealtimeEvent types (../protocol/events.ts) -- `onLog`'s DiplomacyLogEntry
 * has no defined wire event type of its own, so it only persists, it never
 * broadcasts.
 *
 * Persistence/broadcast failures are swallowed here (reported via
 * onPersistError, mirroring ../telemetry/runtime-metrics.ts's own
 * onSample/onPersistError seam) rather than left to propagate back through
 * CapabilityGateway.execute(): by the time onLog/onElevationResolved fires,
 * the actual tool operation has already run (see capability-gateway.ts's
 * execute()/approve()), so a DB hiccup here must never turn an already-
 * successful tool call into a rejected execute() promise.
 */

import { randomUUID } from "node:crypto";

import type { RealtimeEvent, RealtimeEventType } from "../protocol/events.js";
import type { DbCommand, DbCommandResultMap } from "../storage/database.js";
import type { DiplomacyLogEntry, ElevationApprovalRecord, PendingElevationRequest } from "./capability-gateway.js";

/** Minimal structural slice of ../storage/database.ts's DatabaseClient this module depends on -- mirrors ../roles/model-routing.ts's ModelCatalog pattern. A real DatabaseClient satisfies this as-is; tests inject a fake instead of spawning a real DB Worker. */
export interface DiplomacyPersistenceDb {
  request<C extends DbCommand>(command: C): Promise<DbCommandResultMap[C["type"]]>;
}

export interface DiplomacyPersistenceOptions {
  readonly db: DiplomacyPersistenceDb;
  /** Enqueues a fully-formed RealtimeEvent for delivery to every currently-connected client -- typically RuntimeWebSocketServer.broadcast (../transport/websocket-server.ts). Never called for onLog (see the module doc comment). */
  readonly broadcast: (event: RealtimeEvent) => void;
  /** Injectable clock for each broadcast event's own `timestamp` field. Default: the real wall clock. */
  readonly now?: () => Date;
  /** Id generator for each broadcast event's `event_id`. Default: randomUUID(). Inject in tests for deterministic ids. */
  readonly nextEventId?: () => string;
  /**
   * Assigns each emitted event's `sequence`. Default: a private, in-memory
   * counter starting at 1, unique only within this process's lifetime.
   * `diplomacy.elevation.requested`/`resolved` are the first RealtimeEvent
   * types anything on the Node side of this codebase actually emits (every
   * other defined type is currently only ever received, e.g.
   * `voice.transcript.final` in ../tasks/inbound-event-router.ts) -- there is
   * no existing cross-restart sequence source yet to build on. A later task
   * that wants durable-across-restart sequencing for the whole outbound
   * event bus can replace this default without touching this module's
   * public shape.
   */
  readonly nextSequence?: () => number;
  /** Called whenever a persistence write or broadcast throws -- diagnostics only, mirrors ../telemetry/runtime-metrics.ts's onPersistError. Never re-thrown, so a DB/broadcast failure never surfaces back through CapabilityGateway.execute(). */
  readonly onPersistError?: (error: unknown, context: "onLog" | "onElevationRequested" | "onElevationResolved") => void;
}

export interface DiplomacyPersistenceHooks {
  readonly onLog: (entry: DiplomacyLogEntry) => Promise<void>;
  readonly onElevationRequested: (request: PendingElevationRequest) => Promise<void>;
  readonly onElevationResolved: (approval: ElevationApprovalRecord) => Promise<void>;
}

function defaultSequenceCounter(): () => number {
  let sequence = 0;
  return (): number => {
    sequence += 1;
    return sequence;
  };
}

/** Builds the three CapabilityGatewayOptions hooks described in the module doc comment. */
export function createDiplomacyPersistenceHooks(options: DiplomacyPersistenceOptions): DiplomacyPersistenceHooks {
  const now = options.now ?? ((): Date => new Date());
  const nextEventId = options.nextEventId ?? ((): string => randomUUID());
  const nextSequence = options.nextSequence ?? defaultSequenceCounter();
  const onPersistError = options.onPersistError ?? ((): void => {});

  function buildEvent(type: RealtimeEventType, payload: Record<string, unknown>): RealtimeEvent {
    return {
      event_id: nextEventId(),
      sequence: nextSequence(),
      source: "swarm",
      type,
      timestamp: now().toISOString(),
      payload,
    };
  }

  async function guard(
    context: "onLog" | "onElevationRequested" | "onElevationResolved",
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      onPersistError(error, context);
    }
  }

  return {
    onLog: (entry) =>
      guard("onLog", async () => {
        await options.db.request({
          type: "diplomacy.log",
          entry: {
            taskId: entry.taskId,
            roleId: entry.roleId,
            toolName: entry.toolName,
            target: entry.target,
            operation: entry.operation,
            decision: entry.decision,
            impact: entry.impact,
            recoveryNote: entry.recoveryNote ?? null,
            recordedAt: entry.recordedAt,
          },
        });
      }),

    onElevationRequested: (request) =>
      guard("onElevationRequested", async () => {
        const envelope = request.envelope;
        await options.db.request({
          type: "diplomacy.elevation-requested",
          request: {
            requestId: request.requestId,
            taskId: envelope.taskId,
            roleId: envelope.roleId,
            toolName: envelope.toolName,
            target: request.target,
            operation: envelope.operation,
            envelope,
            createdAt: request.createdAt,
          },
        });
        options.broadcast(
          buildEvent("diplomacy.elevation.requested", {
            request_id: request.requestId,
            task_id: envelope.taskId,
            role_id: envelope.roleId,
            tool_name: envelope.toolName,
            target: request.target,
            operation: envelope.operation,
            created_at: request.createdAt,
          }),
        );
      }),

    onElevationResolved: (approval) =>
      guard("onElevationResolved", async () => {
        await options.db.request({
          type: "diplomacy.elevation-resolved",
          approval: {
            requestId: approval.requestId,
            target: approval.target,
            approvedAt: approval.approvedAt,
            expiresAt: approval.expiresAt ?? null,
          },
        });
        options.broadcast(
          buildEvent("diplomacy.elevation.resolved", {
            request_id: approval.requestId,
            target: approval.target,
            approved_at: approval.approvedAt,
            expires_at: approval.expiresAt ?? null,
          }),
        );
      }),
  };
}
