/**
 * The Queen: deterministic (never an LLM) resource-tilting and population
 * governance for the swarm, reacting to food state
 * (../economy/types.ts's FoodState) by deciding how many roles may be
 * active -- design doc sections 6.1 and 7.5-7.6.
 *
 * The Queen is explicitly NOT a central intelligence, NOT a task router, and
 * NOT something users interact with (design doc 6.1's "Queen 明确不能"): it
 * never receives or executes a user task, never answers the user directly,
 * never plans for a specific task, never calls a file/terminal/mail/web
 * tool, and never replaces the Reflex Router, Stress Judge, or Diplomacy
 * Officer. This is a structural guarantee, not a convention -- this class
 * has no `prompt()` method and no `tools` property anywhere on it (see
 * test/ecology/queen.test.ts's boundary test: `"prompt" in queen` and
 * `"tools" in queen` must both be false). There is no code path through
 * which a caller could hand the Queen a user prompt or a tool to invoke,
 * even by mistake.
 *
 * evaluate() is pure and synchronous, exactly like StressJudge.assess()
 * (../routing/stress-judge.ts) and DiplomacyOfficer's rule layer
 * (../tools/diplomacy-officer.ts): it only ever inspects the structured
 * EcologySnapshot it is given and returns a plain EcologyDecision[] --
 * never a string of text, never a model call, never any input the Queen
 * itself couldn't already see as plain data.
 *
 * Decision vocabulary: this task's own mandated tests use a narrower, more
 * specific vocabulary ("freeze_births", "sleep_non_voice_workers") than the
 * design doc's broad "hatch/expand/sleep/merge/retire/hibernate/wake" list.
 * EcologyDecisionKind reconciles the two as follows:
 *   - "allow_hatch"             -> hatch     (prosperous, with activeCap headroom: permission to bring a brand-new ordinary role into the active population; see ./population.ts's PopulationRegistry.hatch())
 *   - "allow_isolated_hatch"    -> hatch     (prosperous, with isolationCap headroom: same permission, scoped to the separate isolation-lifecycle ceiling)
 *   - "allow_expand"            -> expand    (prosperous: permission to grow already-resident roles' capacity)
 *   - "pause_exploration"       -> sleep     (conserving or worse: stop *new* speculative/trial-lifecycle activity; mature/resident roles are simply left alone -- keeping them running needs no decision of its own, see the "conserving" case below)
 *   - "freeze_births"           -> hibernate (reserve or worse, OR activePopulation already at activeCap regardless of food state: stop births specifically, without touching anything already running)
 *   - "sleep_non_voice_workers" -> hibernate (hibernating only -- hard hibernation: actively sleep every non-voice-essential worker, since "no Pi prompts of any kind run" at this food state)
 * "merge" and "wake" aren't triggered by anything this task's evaluate()
 * logic needs; "retire" is exposed on PopulationRegistry for population
 * bookkeeping but nothing here automatically triggers it yet. All three are
 * left for a later task to wire up once a concrete trigger exists.
 *
 * Cadence: design doc 7.5 expects evaluate() to run on a fixed cadence --
 * every 30s OR every 20 task-terminal-state events, whichever comes first.
 * recordTaskTerminalEvent()/isEvaluationDue()/evaluateOnCadence() implement
 * that wrapper. Both thresholds are constructor-configurable and the clock
 * is caller-supplied (`nowMs` is a parameter, this class never calls
 * `Date.now()` itself), mirroring TrafficCommander's seam
 * (../voice/traffic-commander.ts) so tests never wait on a real timer.
 */

import type { FoodState } from "../economy/types.js";

export const ECOLOGY_DECISION_KINDS = [
  "allow_hatch",
  "allow_isolated_hatch",
  "allow_expand",
  "pause_exploration",
  "freeze_births",
  "sleep_non_voice_workers",
] as const;
export type EcologyDecisionKind = (typeof ECOLOGY_DECISION_KINDS)[number];

/** One structured resource/population decision. Deliberately payload-free (just `kind`) at this task's granularity -- see the class doc comment for the full vocabulary and its mapping to the design doc's broader terms. */
export interface EcologyDecision {
  readonly kind: EcologyDecisionKind;
}

/**
 * Everything evaluate() needs to decide, as plain already-observed data --
 * the Queen never looks anything up itself. Shape is this task's own design
 * choice (not pinned by the plan): `food` is mandatory (there is always a
 * current FoodState); population counts/caps mirror
 * ./population.ts's PopulationRegistry (activeCount()/activeCap,
 * activeCount(true)/isolationCap) so a caller normally builds this straight
 * from a PopulationRegistry instance plus whatever produced the FoodState
 * (e.g. ApiBudgetLedger.foodStateFor()). Isolation fields are optional and
 * default to 0 active / cap 1 (this task's stated default) since isolated-
 * lifecycle roles are still a future RpcChamber task's concern.
 */
export interface EcologySnapshot {
  readonly food: FoodState;
  /** Currently-active ordinary (non-isolated-lifecycle) workers. Design doc 7.6's active_population. */
  readonly activePopulation: number;
  /** Max concurrent active ordinary workers. Design doc 7.6's population_cap. */
  readonly activeCap: number;
  /** Currently-active isolated-lifecycle roles. Default 0. */
  readonly isolationActivePopulation?: number;
  /** Max concurrent active isolated-lifecycle roles. Default 1 (this task's stated first-release default). */
  readonly isolationCap?: number;
}

export interface QueenConfig {
  /** Cadence half 1: run evaluate() at least this often. Default 30_000ms (30s, per design doc 7.5). */
  readonly evaluationIntervalMs?: number;
  /** Cadence half 2: run evaluate() once this many task-terminal-state events have been recorded, even if the interval hasn't elapsed yet. Default 20 (per design doc 7.5). */
  readonly evaluationEventThreshold?: number;
}

const DEFAULT_EVALUATION_INTERVAL_MS = 30_000;
const DEFAULT_EVALUATION_EVENT_THRESHOLD = 20;
const DEFAULT_ISOLATION_CAP = 1;
const DEFAULT_ISOLATION_ACTIVE_POPULATION = 0;

export class Queen {
  private readonly evaluationIntervalMs: number;
  private readonly evaluationEventThreshold: number;
  private eventsSinceLastEvaluation = 0;
  private lastEvaluatedAtMs: number | undefined;

  constructor(config: QueenConfig = {}) {
    this.evaluationIntervalMs = config.evaluationIntervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS;
    this.evaluationEventThreshold = config.evaluationEventThreshold ?? DEFAULT_EVALUATION_EVENT_THRESHOLD;
  }

  /**
   * Computes the resource/population decisions implied by `snapshot`, right
   * now, unconditionally -- never gated by cadence itself (see
   * evaluateOnCadence() for the cadence-aware wrapper). See the class doc
   * comment for the exact rule set; summarized:
   *   - prosperous: allow_expand always; allow_hatch/allow_isolated_hatch
   *     when there is activeCap/isolationCap headroom respectively.
   *   - conserving/reserve/hibernating: pause_exploration.
   *   - reserve/hibernating, OR activePopulation already >= activeCap
   *     regardless of food state: freeze_births (additive with the above).
   *   - hibernating only: sleep_non_voice_workers (additive with the above).
   */
  evaluate(snapshot: EcologySnapshot): EcologyDecision[] {
    const isolationCap = snapshot.isolationCap ?? DEFAULT_ISOLATION_CAP;
    const isolationActivePopulation = snapshot.isolationActivePopulation ?? DEFAULT_ISOLATION_ACTIVE_POPULATION;

    const decisions: EcologyDecision[] = [];

    if (snapshot.food === "prosperous") {
      decisions.push({ kind: "allow_expand" });
      if (snapshot.activePopulation < snapshot.activeCap) {
        decisions.push({ kind: "allow_hatch" });
      }
      if (isolationActivePopulation < isolationCap) {
        decisions.push({ kind: "allow_isolated_hatch" });
      }
    } else {
      decisions.push({ kind: "pause_exploration" });
    }

    const atActiveCap = snapshot.activePopulation >= snapshot.activeCap;
    if (snapshot.food === "reserve" || snapshot.food === "hibernating" || atActiveCap) {
      decisions.push({ kind: "freeze_births" });
    }

    if (snapshot.food === "hibernating") {
      decisions.push({ kind: "sleep_non_voice_workers" });
    }

    return decisions;
  }

  /** Records one task reaching a terminal state (completed/failed/cancelled), toward the event-count half of the cadence rule. Purely a counter -- does not itself call evaluate(). */
  recordTaskTerminalEvent(): void {
    this.eventsSinceLastEvaluation += 1;
  }

  /** Whether a fresh evaluate() call is due right now: either the event-count threshold has been reached, or `evaluationIntervalMs` has elapsed since the last evaluateOnCadence() call (or since construction, if there hasn't been one yet). `nowMs` is caller-supplied so this never depends on a real timer. */
  isEvaluationDue(nowMs: number): boolean {
    if (this.eventsSinceLastEvaluation >= this.evaluationEventThreshold) {
      return true;
    }
    if (this.lastEvaluatedAtMs === undefined) {
      return true;
    }
    return nowMs - this.lastEvaluatedAtMs >= this.evaluationIntervalMs;
  }

  /**
   * Cadence-aware wrapper around evaluate(): if isEvaluationDue(nowMs),
   * resets both cadence counters (the event count and the last-evaluated
   * timestamp) and returns evaluate(snapshot)'s decisions; otherwise leaves
   * all bookkeeping untouched and returns `null` (nothing to do yet).
   */
  evaluateOnCadence(nowMs: number, snapshot: EcologySnapshot): EcologyDecision[] | null {
    if (!this.isEvaluationDue(nowMs)) {
      return null;
    }
    this.eventsSinceLastEvaluation = 0;
    this.lastEvaluatedAtMs = nowMs;
    return this.evaluate(snapshot);
  }
}
