/**
 * Role Incubator: proposes a brand-new trial RoleGenome for a genuine
 * capability gap, by minimally mutating the nearest existing genome --
 * design doc sections 8.1 (birth conditions) and 8.3 (incubation flow),
 * and this task's own spec for step 6 ("Incubator can only: copy from the
 * nearest genome / add only the tools+prompt fragments the gap requires /
 * set lifecycle=trial / set a one-task-cycle TTL / record birth reason and
 * death conditions").
 *
 * propose() is a pure function of its two inputs (gap, nearestGenome) --
 * the same inputs always produce the same genome, exactly like
 * ProsperityScore.calculate()/Queen.evaluate() elsewhere in this package.
 * It is deliberately incapable of doing anything beyond the five
 * enumerated actions above: it never invents a capability/tool/prompt
 * fragment the gap did not name, never changes modelPolicy, and never
 * touches fitness beyond resetting it to a fresh baseline (a brand-new
 * genome has no track record yet -- that is bookkeeping, not part of the
 * "minimal mutation" restriction, which is specifically about
 * capabilities/tools/prompt fragments/lifecycle/birth-death). The result is
 * always run through gene-bank.ts's validateGenome() before being returned,
 * so an incubated genome can never violate the same birth/death invariant
 * the Gene Bank itself enforces.
 *
 * CapabilityGap's shape is this task's own design choice (not pinned by the
 * plan, which only fixes propose(gap, nearestGenome) -> RoleGenome):
 * `reason` is drawn from design doc 8.1's five enumerated birth conditions
 * (CAPABILITY_GAP_REASONS below) so a caller can never hand in free text
 * that would let this module improvise a justification; `missingCapabilities`
 * is the actual set of capability strings the current roster cannot serve,
 * and is the one field validated non-empty (a "gap" that names no missing
 * capability is not a gap). `roleId` is caller-supplied -- whatever upstream
 * process detected the gap (a future Queen/orchestration task) decides the
 * new role's name; this module only ever decides genome *content*, never
 * naming.
 */

import type { RoleGenome } from "./gene-bank.js";
import { validateGenome } from "./gene-bank.js";

export const CAPABILITY_GAP_REASONS = [
  "missing_capability",
  "repeated_failure_path",
  "queue_backlog",
  "new_tool_or_protocol",
  "high_novelty",
] as const;
export type CapabilityGapReason = (typeof CAPABILITY_GAP_REASONS)[number];

/**
 * A structured capability-gap description -- never free text (see the
 * module doc comment). This is exactly what design doc 8.1's five birth
 * conditions boil down to for RoleIncubator.propose()'s purposes.
 */
export interface CapabilityGap {
  /** Which of design doc 8.1's birth conditions triggered this gap. */
  readonly reason: CapabilityGapReason;
  /** The new role's id. Caller-assigned -- see the module doc comment for why this module never invents one. */
  readonly roleId: string;
  /** Capabilities the current roster cannot serve. Never empty -- propose() throws otherwise. */
  readonly missingCapabilities: readonly string[];
  /** Tools the missing capabilities actually require, beyond nearestGenome's own. Default: none. */
  readonly requiredTools?: readonly string[];
  /** Prompt fragments the missing capabilities actually require, beyond nearestGenome's own. Default: none. */
  readonly requiredPromptFragments?: readonly string[];
}

/** Thrown by propose() for a structurally-empty gap -- never silently treated as "nothing to do." */
export class InvalidCapabilityGapError extends Error {
  constructor(reason: string) {
    super(`cannot propose a new role: ${reason}`);
    this.name = "InvalidCapabilityGapError";
  }
}

/** One task cycle -- design doc 8.4's "a freshly-incubated role's first run is always a single isolated trial" (新生角色先完成一次隔离试运行). The one place this number lives. */
const TRIAL_TTL_TASK_CYCLES = 1;

/** Baseline death conditions for every freshly-incubated trial genome -- design doc 8.4's promotion rules read backwards: two consecutive failures, or the trial TTL lapsing without promotion, both end a trial genome's run. */
const TRIAL_DEATH_CONDITIONS: readonly string[] = Object.freeze([
  "two_consecutive_task_failures",
  "trial_ttl_expired_without_promotion",
]);

export class RoleIncubator {
  /**
   * Proposes a new trial RoleGenome for `gap`, by minimally mutating
   * `nearestGenome` -- see the module doc comment for exactly what
   * "minimal" means and does not allow. Throws InvalidCapabilityGapError if
   * the gap names no missing capability or no roleId; never silently
   * invents either.
   */
  propose(gap: CapabilityGap, nearestGenome: RoleGenome): RoleGenome {
    if (gap.roleId.trim() === "") {
      throw new InvalidCapabilityGapError("gap.roleId must be non-empty");
    }
    if (gap.missingCapabilities.length === 0) {
      throw new InvalidCapabilityGapError("gap.missingCapabilities must name at least one capability");
    }

    const lifecycle: RoleGenome["lifecycle"] =
      nearestGenome.lifecycle.maxTaskAgeSeconds !== undefined
        ? {
            state: "trial",
            ttlTaskCycles: TRIAL_TTL_TASK_CYCLES,
            maxTaskAgeSeconds: nearestGenome.lifecycle.maxTaskAgeSeconds,
          }
        : { state: "trial", ttlTaskCycles: TRIAL_TTL_TASK_CYCLES };

    const proposed: RoleGenome = {
      roleId: gap.roleId,
      lineage: [...nearestGenome.lineage, nearestGenome.roleId],
      capabilities: union(nearestGenome.capabilities, gap.missingCapabilities),
      tools: union(nearestGenome.tools, gap.requiredTools ?? []),
      promptFragments: union(nearestGenome.promptFragments, gap.requiredPromptFragments ?? []),
      modelPolicy: { ...nearestGenome.modelPolicy },
      birthReason: birthReasonFor(gap),
      deathConditions: TRIAL_DEATH_CONDITIONS,
      lifecycle,
      fitness: { successes: 0, failures: 0, userCorrections: 0 },
    };

    return Object.freeze(validateGenome(proposed));
  }
}

/** Base plus additions, de-duplicated, preserving base's order followed by each new addition's first-seen order. Never drops anything from base, never adds anything not present in either input -- the one place "minimal mutation" list-merging happens. */
function union(base: readonly string[], additions: readonly string[]): readonly string[] {
  const seen = new Set(base);
  const result = [...base];
  for (const addition of additions) {
    if (!seen.has(addition)) {
      seen.add(addition);
      result.push(addition);
    }
  }
  return Object.freeze(result);
}

function birthReasonFor(gap: CapabilityGap): string {
  return `${gap.reason}: missing [${gap.missingCapabilities.join(", ")}]`;
}
