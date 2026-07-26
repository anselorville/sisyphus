/**
 * ProviderRouter: picks which LLM provider a task should run against, given
 * the swarm's current food state per provider (see ./api-budget.ts and
 * ./subscription-quota.ts). This module is deliberately pure ranking logic
 * over plain data -- it never calls into ApiBudgetLedger or HttpQuotaProbe
 * itself; a caller is expected to compute each ProviderCandidate's
 * foodState (via ApiBudgetLedger.foodStateFor()/HttpQuotaProbe.refresh())
 * and pass it in. That keeps this file trivial to unit test and decoupled
 * from how any given provider's food is actually produced.
 *
 * Neither TaskProfile nor ProviderCandidate's exact shape is pinned by the
 * design doc (see Task 13's own prompt) -- both are new, minimal, documented
 * choices made here:
 *
 *   - TaskProfile.requiredCapabilities / requiredModelTier are hard filters:
 *     a provider missing either is dropped entirely, never merely
 *     down-ranked. A voice-latency-sensitive task should never silently
 *     land on a provider that can't actually do what it needs.
 *   - ProviderCandidate.recentLatencyMs is a single caller-maintained
 *     number (e.g. a rolling average or EWMA) -- ProviderRouter only ever
 *     compares the numbers it's given, it doesn't maintain history itself.
 *   - choose() returns every eligible provider in ranked order (best
 *     first), not just a single winner, so a caller can retry against the
 *     next-best candidate without a second call. `choose(...)[0]` is the
 *     router's actual recommendation.
 *   - Ranking order: (1) FoodState, healthier first -- the entire point of
 *     this module is steering load toward providers with food to spare
 *     before they're forced to throttle down; (2) distance from
 *     requiredModelTier, closest first -- prefer the cheapest capable tier
 *     rather than always reaching for the biggest model available, since
 *     overspending on tier accelerates every provider's trip toward
 *     hibernating, which works against (1) for every future task; (3)
 *     recentLatencyMs, lower first, as the final tiebreaker.
 */

import type { FoodState } from "./types.js";

/** Coarse capability tier, ordered cheapest to most capable so tier comparisons are plain integer math (see TIER_RANK). */
export type ModelTier = "economy" | "standard" | "flagship";

const TIER_RANK: Readonly<Record<ModelTier, number>> = Object.freeze({
  economy: 0,
  standard: 1,
  flagship: 2,
});

const FOOD_STATE_RANK: Readonly<Record<FoodState, number>> = Object.freeze({
  prosperous: 0,
  conserving: 1,
  reserve: 2,
  hibernating: 3,
});

/** What a task needs from whichever provider ends up running it. See the module doc comment for why this shape. */
export interface TaskProfile {
  /** Tool/model features the provider must support (e.g. "vision", "tool-use"). Default: none required. */
  readonly requiredCapabilities?: readonly string[];
  /** Minimum ModelTier capable of doing the task at all. Default: "economy" (accepts any tier). */
  readonly requiredModelTier?: ModelTier;
}

/** A provider's routing-relevant state, already computed by the caller. See the module doc comment. */
export interface ProviderCandidate {
  readonly providerId: string;
  readonly capabilities: readonly string[];
  readonly modelTier: ModelTier;
  readonly foodState: FoodState;
  /** Recent observed latency for this provider, in milliseconds. Lower is preferred. */
  readonly recentLatencyMs: number;
}

export class ProviderRouter {
  /**
   * Filters `providers` down to those capable of `taskProfile`, then ranks
   * the survivors best-first (see the module doc comment for the exact
   * order). Returns an empty array -- never throws -- when nothing
   * qualifies; it's up to the caller (eventually the Queen) to decide what
   * "no eligible provider" means for its own flow.
   */
  choose(taskProfile: TaskProfile, providers: readonly ProviderCandidate[]): readonly ProviderCandidate[] {
    const requiredCapabilities = taskProfile.requiredCapabilities ?? [];
    const requiredTierRank = TIER_RANK[taskProfile.requiredModelTier ?? "economy"];

    const eligible = providers.filter(
      (provider) =>
        requiredCapabilities.every((capability) => provider.capabilities.includes(capability)) &&
        TIER_RANK[provider.modelTier] >= requiredTierRank,
    );

    return eligible.sort((a, b) => {
      const foodDelta = FOOD_STATE_RANK[a.foodState] - FOOD_STATE_RANK[b.foodState];
      if (foodDelta !== 0) {
        return foodDelta;
      }

      const tierDelta =
        Math.abs(TIER_RANK[a.modelTier] - requiredTierRank) - Math.abs(TIER_RANK[b.modelTier] - requiredTierRank);
      if (tierDelta !== 0) {
        return tierDelta;
      }

      return a.recentLatencyMs - b.recentLatencyMs;
    });
  }
}
