/**
 * Role Experience Tracker: the per-role running counters
 * evaluateRoleLifecycle() (./pheromone-map.ts) needs as its
 * RoleExperienceSnapshot input -- "the caller assembles this from real
 * history; this function never looks anything up itself" (see that
 * function's own doc comment). Nothing in this codebase tracked that history
 * anywhere before this module: evaluateRoleLifecycle() was a pure decision
 * function with no caller wiring it to a real task outcome (see
 * ../README.md's roadmap item 3).
 *
 * In-memory only, mirroring ./gene-bank.ts/./population.ts's own documented
 * choice for this same task generation -- lost on process restart, exactly
 * like every other ecology structure until a later task builds real SQLite-
 * backed recovery for all of them together.
 *
 * `hadSeriousIncident` is always reported as `false`: no part of this
 * codebase currently produces a "this task's success was accompanied by a
 * serious incident" signal (e.g. a diplomacy escalation that reached the
 * user) that could feed it. Recording `false` unconditionally is the honest
 * choice -- never fabricating a signal that doesn't exist yet -- rather than
 * guessing. A later task that adds real incident detection can thread it
 * through recordOutcome()'s options without changing this module's shape.
 */

import type { RoleExperienceSnapshot } from "./pheromone-map.js";

export type RoleTaskOutcome = "success" | "failure";

interface MutableRoleExperience {
  crossTaskSuccessCount: number;
  consecutiveFailures: number;
  lastUsedAtMs: number;
}

export class RoleExperienceTracker {
  private readonly byRoleId = new Map<string, MutableRoleExperience>();

  /**
   * Records one task's terminal outcome for `roleId` and returns the
   * resulting snapshot: a success increments crossTaskSuccessCount and
   * resets consecutiveFailures to 0; a failure increments
   * consecutiveFailures and leaves crossTaskSuccessCount unchanged (it only
   * ever moves via a success or an explicit resetAfterPromotion()).
   */
  recordOutcome(roleId: string, outcome: RoleTaskOutcome, nowMs: number): RoleExperienceSnapshot {
    const experience = this.byRoleId.get(roleId) ?? { crossTaskSuccessCount: 0, consecutiveFailures: 0, lastUsedAtMs: nowMs };

    if (outcome === "success") {
      experience.crossTaskSuccessCount += 1;
      experience.consecutiveFailures = 0;
    } else {
      experience.consecutiveFailures += 1;
    }
    experience.lastUsedAtMs = nowMs;

    this.byRoleId.set(roleId, experience);
    return this.snapshot(experience);
  }

  /** Current snapshot for `roleId`, or a fresh all-zero one if it has never recorded an outcome. Never mutates tracked state. */
  get(roleId: string): RoleExperienceSnapshot {
    const experience = this.byRoleId.get(roleId) ?? { crossTaskSuccessCount: 0, consecutiveFailures: 0, lastUsedAtMs: 0 };
    return this.snapshot(experience);
  }

  /**
   * Zeroes `crossTaskSuccessCount` for `roleId` -- call once a
   * "promote_resident" decision has actually been applied, matching
   * evaluateRoleLifecycle()'s own doc comment: crossTaskSuccessCount counts
   * successes "since its last promotion (or since birth)", not a lifetime
   * total. Never throws for an untracked roleId (a no-op: there is nothing
   * to reset).
   */
  resetAfterPromotion(roleId: string, nowMs: number): void {
    const experience = this.byRoleId.get(roleId);
    if (!experience) {
      return;
    }
    experience.crossTaskSuccessCount = 0;
    experience.lastUsedAtMs = nowMs;
  }

  private snapshot(experience: MutableRoleExperience): RoleExperienceSnapshot {
    return Object.freeze({
      crossTaskSuccessCount: experience.crossTaskSuccessCount,
      consecutiveFailures: experience.consecutiveFailures,
      hadSeriousIncident: false,
      lastUsedAtMs: experience.lastUsedAtMs,
    });
  }
}
