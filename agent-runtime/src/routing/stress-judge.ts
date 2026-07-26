/**
 * Stress Judge: the swarm's "应激裁判" (stress arbiter). A low-cost,
 * resident, explainable classifier that answers exactly one question --
 * does the current situation exceed what baseline/steady-state workers can
 * handle -- and nothing else.
 *
 * Per .proj-init/02-swarm-agent-architecture-for-realtime-voice.md section
 * 4.6 and this task's spec, Stress Judge:
 *   - never answers the user directly,
 *   - never plans,
 *   - never calls a tool,
 *   - never calls a model (deterministic arithmetic over caller-supplied
 *     signals only),
 *   - only ever outputs one of three fixed enum decisions.
 *
 * It scores three independent axes (entropy / risk / novelty) from plain
 * facts the caller already observed (failure counters, risk flags, route
 * confidence, ...) -- it never inspects raw transcript text itself, and it
 * never fabricates a signal it wasn't given. `stress_score = max(entropy,
 * risk, novelty)` mirrors the design doc's formula; the four score bands
 * described there (homeostasis / local perturbation / stress warning /
 * stress overflow) collapse onto this task's three allowed decisions as
 * stay_baseline / activate_specialists / activate_specialists /
 * spawn_intelligence_caste, since only three enum values are permitted here.
 */

export const STRESS_DECISIONS = ["stay_baseline", "activate_specialists", "spawn_intelligence_caste"] as const;
export type StressDecision = (typeof STRESS_DECISIONS)[number];

/**
 * Pre-computed, plain-fact inputs for one routing decision. Every field is
 * something the caller already observed -- StressJudge does no inference of
 * its own beyond the fixed arithmetic below.
 */
export interface StressSignals {
  // Entropy axis: link chaos / failure density / conflicting signals.
  readonly consecutiveRouteFailures?: number;
  readonly consecutiveToolFailures?: number;
  readonly conflictingSignals?: boolean;
  readonly userCorrectionCount?: number;
  readonly backgroundStallMs?: number;

  // Risk axis: irreversibility / privacy / privilege / availability.
  readonly irreversible?: boolean;
  readonly privacySensitive?: boolean;
  readonly privileged?: boolean;
  readonly threatensAvailability?: boolean;

  // Novelty axis: unknown route / low confidence / new domain.
  readonly hasKnownRoute?: boolean;
  readonly lowRouteConfidence?: boolean;
  readonly novelDomain?: boolean;
  /** 0..1; lower means less confident. */
  readonly workerConfidence?: number;
}

const STRESS_WARNING_THRESHOLD = 0.4; // >= this: at least activate_specialists
const STRESS_OVERFLOW_THRESHOLD = 0.8; // >= this: spawn_intelligence_caste

export class StressJudge {
  /** Pure, synchronous, deterministic. Never calls a model. */
  assess(signals: StressSignals = {}): StressDecision {
    const stressScore = Math.max(entropyScore(signals), riskScore(signals), noveltyScore(signals));

    if (stressScore >= STRESS_OVERFLOW_THRESHOLD) {
      return "spawn_intelligence_caste";
    }
    if (stressScore >= STRESS_WARNING_THRESHOLD) {
      return "activate_specialists";
    }
    return "stay_baseline";
  }
}

function entropyScore(s: StressSignals): number {
  let score = 0;
  if ((s.consecutiveRouteFailures ?? 0) >= 2) {
    score = Math.max(score, 0.5);
  }
  if ((s.consecutiveToolFailures ?? 0) >= 3) {
    score = Math.max(score, 0.5);
  }
  if (s.conflictingSignals) {
    score = Math.max(score, 0.45);
  }
  if ((s.userCorrectionCount ?? 0) >= 2) {
    score = Math.max(score, 0.5);
  }
  const stallMs = s.backgroundStallMs ?? 0;
  if (stallMs >= 10_000) {
    score = Math.max(score, 0.85);
  } else if (stallMs >= 5_000) {
    score = Math.max(score, 0.5);
  }
  return clamp01(score);
}

function riskScore(s: StressSignals): number {
  let score = 0;
  if (s.threatensAvailability) {
    score = Math.max(score, 0.9);
  }
  if (s.privileged) {
    score = Math.max(score, 0.85);
  }
  if (s.irreversible) {
    score = Math.max(score, 0.7);
  }
  if (s.privacySensitive) {
    score = Math.max(score, 0.6);
  }
  return clamp01(score);
}

function noveltyScore(s: StressSignals): number {
  let score = 0;
  if (s.hasKnownRoute === false) {
    score = Math.max(score, 0.85);
  }
  if (s.lowRouteConfidence) {
    score = Math.max(score, 0.5);
  }
  if (s.novelDomain) {
    score = Math.max(score, 0.7);
  }
  if (s.workerConfidence !== undefined && s.workerConfidence < 0.3) {
    score = Math.max(score, 0.6);
  }
  return clamp01(score);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
