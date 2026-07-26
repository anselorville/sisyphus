/**
 * Shared vocabulary for the swarm's economy layer (see ./api-budget.ts and
 * ./subscription-quota.ts for the two independent kinds of "food" this
 * describes, and ./provider-router.ts for the thing that reads it).
 *
 * There are exactly two kinds of food -- a pay-as-you-go API Budget and a
 * coding-plan-style Subscription Quota -- and they are never converted into
 * a shared currency (see
 * .proj-init/04-autonomous-swarm-voice-agent-software-design.md section
 * 7.2-7.4). Both are summarized through this same four-band FoodState so a
 * later consumer (the Queen, who governs swarm population from food state)
 * can reason about either kind uniformly without caring which one a given
 * provider produces.
 */

/**
 * The four ecology bands the swarm's population governance reacts to,
 * healthiest first:
 *   - prosperous:  remaining ratio > 30%
 *   - conserving:  15% <= remaining ratio <= 30%
 *   - reserve:     5% <= remaining ratio < 15%
 *   - hibernating: remaining ratio < 5%
 *
 * Boundary values fall into the lower (more conservative) of the two bands
 * they touch, except at the very top: exactly 30% is "conserving", not
 * "prosperous" -- prosperous requires being strictly above the threshold.
 * It is always safer to under-report remaining food than to over-report it.
 */
export type FoodState = "prosperous" | "conserving" | "reserve" | "hibernating";

const PROSPEROUS_ABOVE = 0.3;
const CONSERVING_AT_OR_ABOVE = 0.15;
const RESERVE_AT_OR_ABOVE = 0.05;

/** Maps a 0-1 remaining ratio to its FoodState band. See the type's own doc comment above for the exact boundary convention. */
export function foodState(remainingRatio: number): FoodState {
  if (remainingRatio > PROSPEROUS_ABOVE) {
    return "prosperous";
  }
  if (remainingRatio >= CONSERVING_AT_OR_ABOVE) {
    return "conserving";
  }
  if (remainingRatio >= RESERVE_AT_OR_ABOVE) {
    return "reserve";
  }
  return "hibernating";
}
