/**
 * Prosperity Score: the Queen's one deterministic, weighted formula for how
 * healthy a role/the swarm is doing right now -- design doc section 7.5.
 * Fixed weights, summing to 1.0:
 *
 *   | signal                                             | weight | direction         |
 *   |------------------------------------------------------|--------|-------------------|
 *   | task success rate                                    | 40%    | higher is better  |
 *   | user correction rate                                 | 20%    | higher is WORSE (inverted) |
 *   | response timeout rate                                | 15%    | higher is WORSE (inverted) |
 *   | role reuse rate                                      | 15%    | higher is better  |
 *   | verification-failure / external-incident rate        | 10%    | higher is WORSE (inverted) |
 *
 * Every one of ProsperitySignals' five fields is something the caller
 * already objectively observed -- test/verification outcomes, explicit user
 * corrections, measured response timeouts, measured role reuse. There is no
 * "confidence"/"self_rating"/"self-assessment" field anywhere on this type,
 * deliberately: an LLM is never allowed to self-report its own prosperity
 * (this task's own Global Constraints, and design doc 7.5). Only
 * externally-observed counts/rates ever reach this formula -- see
 * test/ecology/prosperity.test.ts's compile-time guarantee that
 * ProsperitySignals can never grow such a field.
 */

export interface ProsperitySignals {
  /** Fraction of tasks that reached a successful terminal state. 0..1 -- values outside this range are clamped, never thrown on (see calculate()). */
  readonly taskSuccessRate: number;
  /** Fraction of turns the user had to correct the swarm's output. 0..1. Higher LOWERS the score. */
  readonly userCorrectionRate: number;
  /** Fraction of responses that missed their expected turnaround. 0..1. Higher LOWERS the score. */
  readonly responseTimeoutRate: number;
  /** Fraction of role invocations that reused an already-active session rather than hatching a brand-new one. 0..1. Higher RAISES the score. */
  readonly roleReuseRate: number;
  /** Fraction of actions that failed verification or produced an external/diplomatic incident. 0..1. Higher LOWERS the score. */
  readonly verificationFailureRate: number;
}

/** Fixed weights from the design doc's table above. Sum to exactly 1.0 -- the one place this formula's shape lives. */
const WEIGHTS = Object.freeze({
  taskSuccessRate: 0.4,
  userCorrectionRate: 0.2,
  responseTimeoutRate: 0.15,
  roleReuseRate: 0.15,
  verificationFailureRate: 0.1,
});

export class ProsperityScore {
  /**
   * Deterministic weighted sum, clamped to [0, 1]. Every inverted signal
   * (correction/timeout/verification-failure rate) contributes `(1 - rate)`
   * so a higher observed rate of bad outcomes always pulls the score down.
   * Pure and synchronous -- never calls a model, never reads a self-reported
   * field, because ProsperitySignals has none.
   */
  calculate(signals: ProsperitySignals): number {
    const taskSuccessRate = clamp01(signals.taskSuccessRate);
    const userCorrectionRate = clamp01(signals.userCorrectionRate);
    const responseTimeoutRate = clamp01(signals.responseTimeoutRate);
    const roleReuseRate = clamp01(signals.roleReuseRate);
    const verificationFailureRate = clamp01(signals.verificationFailureRate);

    const score =
      WEIGHTS.taskSuccessRate * taskSuccessRate +
      WEIGHTS.userCorrectionRate * (1 - userCorrectionRate) +
      WEIGHTS.responseTimeoutRate * (1 - responseTimeoutRate) +
      WEIGHTS.roleReuseRate * roleReuseRate +
      WEIGHTS.verificationFailureRate * (1 - verificationFailureRate);

    return clamp01(score);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
