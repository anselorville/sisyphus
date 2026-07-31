/**
 * Population Registry: the Queen's own bookkeeping of which roles exist and
 * which of them currently count as "active" -- design doc section 7.6's
 * resident_population / active_population / population_cap / isolation_cap.
 *
 * Deliberately independent of RoleSessionManager
 * (../roles/session-manager.ts): this registry tracks population *counts
 * and caps* as plain data the Queen can reason about (see ./queen.ts's
 * EcologySnapshot). It never holds a real Pi Session and never calls
 * prompt()/steer()/any tool -- hatch()/sleep()/retire() are pure bookkeeping
 * transitions over an in-memory map, mirroring RoleManifestRegistry's own
 * "just a lookup" shape (../roles/registry.ts). Keeping the two population
 * views (this registry's counts vs. RoleSessionManager's real sessions) in
 * sync is a later orchestration task's job, not this module's.
 *
 * Three membership statuses map onto the design doc's two named buckets:
 *   - "active":   counts toward active_population.
 *   - "sleeping": still part of resident_population (can hatch() again --
 *     mirrors RoleSessionManager.sleep()'s "manifest stays registered"
 *     guarantee) but no longer counts as active.
 *   - "retired":  permanently out of the population; a later hatch() call
 *     under the same roleId starts a brand-new membership rather than
 *     waking this one.
 *
 * activeCap/isolationCap are two independent ceilings (never merged into one
 * shared number, same "no shared currency" discipline as ../economy/types.ts):
 * activeCap bounds ordinary (non-isolated-lifecycle) active members,
 * isolationCap separately bounds isolated-lifecycle active members. Defaults
 * (4 and 1) match this task's spec.
 */

import type { RoleLifecycle } from "../roles/types.js";

export type PopulationMemberStatus = "active" | "sleeping" | "retired";

/** One role's current population bookkeeping. Frozen -- a read-only snapshot, never a handle a caller can mutate in place. */
export interface PopulationMember {
  readonly roleId: string;
  readonly lifecycle: RoleLifecycle;
  readonly status: PopulationMemberStatus;
}

export interface PopulationRegistryOptions {
  /** Max concurrent active ordinary (non-isolated-lifecycle) workers. Default 4. */
  readonly activeCap?: number;
  /** Max concurrent active isolated-lifecycle roles. Default 1 (first release). */
  readonly isolationCap?: number;
}

/** Thrown by hatch() rather than silently exceeding activeCap/isolationCap -- a cap is a hard resource ceiling, never a soft suggestion. */
export class PopulationCapExceededError extends Error {
  constructor(roleId: string, cap: number, isolation: boolean) {
    super(
      `cannot hatch role "${roleId}": ${isolation ? "isolation" : "active population"} cap of ${cap} already reached`,
    );
    this.name = "PopulationCapExceededError";
  }
}

const DEFAULT_ACTIVE_CAP = 4;
const DEFAULT_ISOLATION_CAP = 1;

interface MemberEntry {
  readonly lifecycle: RoleLifecycle;
  readonly status: PopulationMemberStatus;
}

export class PopulationRegistry {
  private readonly _activeCap: number;
  private readonly _isolationCap: number;
  private readonly members = new Map<string, MemberEntry>();

  constructor(options: PopulationRegistryOptions = {}) {
    this._activeCap = options.activeCap ?? DEFAULT_ACTIVE_CAP;
    this._isolationCap = options.isolationCap ?? DEFAULT_ISOLATION_CAP;
  }

  get activeCap(): number {
    return this._activeCap;
  }

  get isolationCap(): number {
    return this._isolationCap;
  }

  /**
   * Brings `roleId` into the active population under `lifecycle` (default
   * "resident"), whether that means registering it for the first time or
   * re-activating a previously sleeping/retired member. A no-op that just
   * returns the current member when it is already active -- `lifecycle` is
   * ignored in that one case. Otherwise throws PopulationCapExceededError
   * without mutating anything when doing so would push the relevant cap
   * (activeCap for ordinary lifecycles, isolationCap for "isolated") over
   * its limit.
   *
   * Callers are expected to pass the same `lifecycle` consistently for a
   * given roleId across its lifetime (mirroring how RoleManifest.lifecycle
   * is fixed per role) -- this registry does not itself remember a
   * sleeping/retired member's previous lifecycle.
   */
  hatch(roleId: string, lifecycle: RoleLifecycle = "resident"): PopulationMember {
    const existing = this.members.get(roleId);
    if (existing?.status === "active") {
      return toMember(roleId, existing);
    }

    const isolation = lifecycle === "isolated";
    const cap = isolation ? this._isolationCap : this._activeCap;
    if (this.activeCount(isolation) >= cap) {
      throw new PopulationCapExceededError(roleId, cap, isolation);
    }

    const member: MemberEntry = { lifecycle, status: "active" };
    this.members.set(roleId, member);
    return toMember(roleId, member);
  }

  /**
   * Moves an active role to "sleeping" -- it remains part of the resident
   * population (a later hatch() call wakes it again) but no longer counts
   * against activeCap/isolationCap. Harmless no-op if `roleId` is unknown or
   * already sleeping/retired.
   */
  sleep(roleId: string): void {
    const existing = this.members.get(roleId);
    if (!existing || existing.status !== "active") {
      return;
    }
    this.members.set(roleId, { lifecycle: existing.lifecycle, status: "sleeping" });
  }

  /**
   * Permanently removes a role from the population -- unlike sleep(), a
   * retired member never wakes again; a fresh hatch() call under the same
   * roleId starts a brand-new membership. Harmless no-op if `roleId` is
   * unknown or already retired.
   */
  retire(roleId: string): void {
    const existing = this.members.get(roleId);
    if (!existing || existing.status === "retired") {
      return;
    }
    this.members.set(roleId, { lifecycle: existing.lifecycle, status: "retired" });
  }

  /** Current bookkeeping for `roleId`, or undefined if it has never been hatch()ed. */
  get(roleId: string): PopulationMember | undefined {
    const existing = this.members.get(roleId);
    return existing ? toMember(roleId, existing) : undefined;
  }

  /**
   * Re-activates a currently-sleeping member, preserving its original
   * lifecycle -- the concrete trigger for the design doc's "wake" decision,
   * never triggered by anything until Roadmap item 5 (see
   * ../ecology/queen.ts's module doc comment). A harmless no-op (returns
   * undefined) for a roleId that is unknown, already active, or retired --
   * "wake" only ever applies to a role this registry currently considers
   * "sleeping" (mirrors sleep()'s own precondition, just the reverse
   * transition). Delegates to hatch() for the actual cap-checking/mutation,
   * so waking a role still respects activeCap/isolationCap exactly like
   * bringing in a brand-new role would -- it can throw
   * PopulationCapExceededError.
   */
  wake(roleId: string): PopulationMember | undefined {
    const existing = this.members.get(roleId);
    if (!existing || existing.status !== "sleeping") {
      return undefined;
    }
    return this.hatch(roleId, existing.lifecycle);
  }

  /** Every role this registry has ever hatched, in insertion order, including sleeping and retired ones. */
  list(): readonly PopulationMember[] {
    return [...this.members.entries()].map(([roleId, member]) => toMember(roleId, member));
  }

  /** Count of currently-active members: ordinary (non-isolated) by default, or isolated-lifecycle only when `isolation` is true. Matches design doc 7.6's active_population, split by the same activeCap/isolationCap boundary hatch() enforces. */
  activeCount(isolation = false): number {
    let count = 0;
    for (const member of this.members.values()) {
      if (member.status === "active" && (member.lifecycle === "isolated") === isolation) {
        count += 1;
      }
    }
    return count;
  }
}

function toMember(roleId: string, member: MemberEntry): PopulationMember {
  return Object.freeze({ roleId, lifecycle: member.lifecycle, status: member.status });
}
