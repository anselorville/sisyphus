/**
 * Shared shapes for the role/session layer: what a role *is* (RoleManifest),
 * what running instance of it looks like once a Pi Session backs it
 * (ManagedRoleSession), and the manager that owns the pool of those
 * instances (RoleSessionManager).
 *
 * This module is a dependency-light leaf (mirrors ../protocol/events.ts):
 * it only declares shapes, plus the minimal structural slice of the real
 * `@earendil-works/pi-coding-agent` SDK this layer depends on. Concrete
 * behavior lives in ./session-manager.ts and ./pi-event-adapter.ts.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { RealtimeEventType } from "../protocol/events.js";

/** Coarse capability/cost tier a role's manifest requests. Routing an actual provider/model to each tier is a later task's concern -- this layer only carries the declared intent. */
export type RoleModelClass = "fast" | "balanced" | "deep";

/**
 * Subset of the real SDK's `ThinkingLevel` (`off | minimal | low | medium |
 * high | xhigh | max`, from @earendil-works/pi-agent-core) that role
 * manifests are allowed to request. A RoleThinkingLevel value is always a
 * valid real ThinkingLevel, so it can be passed straight through.
 */
export type RoleThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/**
 * How a role's Pi Session is hosted:
 * - "resident": long-lived, shares this Node process with every other
 *   resident role (this task's scope).
 * - "trial": newly hatched, running under probation before promotion.
 * - "isolated": runs in a separate Pi RPC sandbox (a future task's
 *   RpcChamber, not built here).
 * RoleSessionManager in this file only implements in-process hosting; the
 * field is carried through so later tasks can branch on it.
 */
export type RoleLifecycle = "resident" | "trial" | "isolated";

/** Static definition of a role: what it can do, what it's allowed to touch, and how its Pi Session should be built. */
export interface RoleManifest {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly promptPath: string;
  readonly modelClass: RoleModelClass;
  readonly thinkingLevel: RoleThinkingLevel;
  readonly lifecycle: RoleLifecycle;
}

/**
 * One mapped-and-possibly-aggregated update produced by PiEventAdapter from
 * one or more underlying Pi SDK events. Deliberately does not know about
 * role/task identity -- ManagedRoleSession layers that on (see
 * RoleSessionUpdate) so the adapter itself stays a pure event mapper.
 */
export interface MappedPiUpdate {
  readonly type: RealtimeEventType;
  readonly payload: Record<string, unknown>;
}

/** A MappedPiUpdate enriched with the role and (if any) task it belongs to -- what ManagedRoleSession broadcasts to its own subscribers. */
export interface RoleSessionUpdate extends MappedPiUpdate {
  readonly roleId: string;
  readonly taskId: string | undefined;
}

/**
 * Minimal structural slice of `@earendil-works/pi-coding-agent`'s real
 * `AgentSession` that this layer depends on. A real AgentSession instance
 * satisfies this interface as-is (verified against
 * node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts)
 * -- no adapter/wrapper needed in production. Unit tests inject a fake
 * implementation instead of constructing a real Pi backend.
 */
export interface PiSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly messages: readonly unknown[];
}

/** Builds the underlying Pi Session for a role. Production wiring calls the real `createAgentSession()`; tests inject a fake that never touches a live Pi backend. */
export type PiSessionProvider = (manifest: RoleManifest) => Promise<PiSession>;

/**
 * A live, running instance of a role: exactly one independent Pi Session,
 * plus the bookkeeping needed to release it cleanly. Every subscription
 * this session holds (its own listen on the underlying PiSession, and any
 * consumer that calls subscribe() here) is released by dispose() -- see
 * activeSubscriptionCount.
 */
export interface ManagedRoleSession {
  readonly manifest: RoleManifest;
  readonly roleId: string;
  readonly currentTaskId: string | undefined;
  /** Number of currently-held release-worthy resources (the internal Pi event subscription, its flush timer, and any external subscribe() listeners). Always 0 after dispose(). */
  readonly activeSubscriptionCount: number;
  readonly messages: readonly unknown[];
  prompt(taskId: string, text: string): Promise<void>;
  steer(taskId: string, text: string): Promise<void>;
  followUp(taskId: string, text: string): Promise<void>;
  abort(taskId: string): Promise<void>;
  /** Subscribe to aggregated role updates (task.progress, tool.started, ...). Returns an unsubscribe function; unsubscribing is itself a release (reflected in activeSubscriptionCount). */
  subscribe(listener: (update: RoleSessionUpdate) => void): () => void;
  /** Unsubscribes everything and disposes the underlying Pi Session. Idempotent. */
  dispose(): void;
}

/**
 * Owns the pool of ManagedRoleSessions, one per role id, each backed by its
 * own independent Pi Session. Matches the interface contract fixed by
 * .proj-init/05-autonomous-swarm-voice-agent-development-action-plan.md
 * (section 3) verbatim.
 */
export interface RoleSessionManager {
  ensure(role: RoleManifest): Promise<ManagedRoleSession>;
  prompt(roleId: string, taskId: string, text: string): Promise<void>;
  steer(roleId: string, taskId: string, text: string): Promise<void>;
  followUp(roleId: string, taskId: string, text: string): Promise<void>;
  abort(roleId: string, taskId: string): Promise<void>;
  /** Puts a role to sleep: disposes its ManagedRoleSession (unsubscribing everything) and evicts it from the active pool. The role's manifest remains registered, so a later prompt()/ensure() call wakes it again with a fresh Pi Session. */
  sleep(roleId: string): Promise<void>;
  /** Disposes every currently-active role session. */
  close(): Promise<void>;
}
