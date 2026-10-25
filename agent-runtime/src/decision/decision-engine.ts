/**
 * DecisionEngine: runs the runtime's fixed-pattern decisions through Jev with
 * a deterministic rule as the always-available baseline.
 *
 * A "decision" here is a choice among options known in advance, whose answer
 * goes straight into an `if` -- which role handles this utterance, whether
 * "好" is answering the pending question. Generation, arithmetic and exact
 * lookups stay in code or the LLM; see the X-Notebook Jev notes for the split.
 *
 * The engine is deliberately conservative, following the rollout discipline
 * those notes recommend:
 *
 *   off    -- rules only; Jev is never called.
 *   shadow -- rules decide. Jev is asked in the background and the two are
 *             compared and logged, adding no latency and changing nothing.
 *             This is how thresholds get calibrated on real traffic.
 *   live   -- Jev decides when it is reachable, confident (per the spec's own
 *             thresholds) and fast enough; otherwise the rule decides.
 *
 * Every decision, in every mode, produces a DecisionRecord so agreement,
 * latency and fallbacks can be audited later. Thresholds live in the specs, in
 * code, where a pull request can review them -- not in the model.
 */

import type { JevClient, JevQuestion, JevResponse } from "./jev-client.js";
import { JevError } from "./jev-client.js";

export type DecisionMode = "off" | "shadow" | "live";

export const DECISION_MODES: readonly DecisionMode[] = ["off", "shadow", "live"];

/** One decision point: what to ask, and how to turn the answers into a value or decline to. */
export interface DecisionSpec<Input, Output> {
  readonly name: string;
  /** Bump when the questions, criteria or thresholds change, so logged decisions stay comparable. */
  readonly version: string;
  /** Hard time budget for the Jev call; past it the rule decides. */
  readonly budgetMs: number;
  buildRequest(input: Input): { state: unknown; questions: Readonly<Record<string, JevQuestion>> };
  /** Returns undefined when Jev is not confident enough to override the rule. */
  interpret(response: JevResponse, input: Input): { readonly value: Output; readonly confidence: number } | undefined;
  /** Short label used in logs and for the agreement comparison. */
  describe(value: Output): string;
}

export type DecisionSource = "jev" | "rule" | "rule_fallback";

export interface DecisionRecord {
  readonly decision: string;
  readonly version: string;
  readonly mode: DecisionMode;
  /** Who produced the value the caller actually used. */
  readonly source: DecisionSource;
  readonly chosen: string;
  readonly baseline: string;
  /** Whether Jev's answer matches the rule's; undefined when Jev did not produce one. */
  readonly agreed: boolean | undefined;
  readonly jev: string | undefined;
  readonly confidence: number | undefined;
  readonly latencyMs: number | undefined;
  /** Why the rule was used instead of Jev ("not_ready", "timeout", "low_confidence", ...). */
  readonly fallbackReason: string | undefined;
}

export interface DecisionEngineOptions {
  readonly client: JevClient;
  readonly mode: DecisionMode;
  readonly onRecord?: (record: DecisionRecord) => void;
  readonly now?: () => number;
}

export class DecisionEngine {
  private mode: DecisionMode;
  private readonly client: JevClient;
  private readonly onRecord: (record: DecisionRecord) => void;
  private readonly now: () => number;

  constructor(options: DecisionEngineOptions) {
    this.client = options.client;
    this.mode = options.mode;
    this.onRecord = options.onRecord ?? ((): void => {});
    this.now = options.now ?? ((): number => Date.now());
  }

  get currentMode(): DecisionMode {
    return this.mode;
  }

  setMode(mode: DecisionMode): void {
    this.mode = mode;
  }

  /** The value the caller should use. `baseline` is the rule's answer, already computed. */
  async decide<Input, Output>(spec: DecisionSpec<Input, Output>, input: Input, baseline: Output): Promise<Output> {
    if (this.mode === "off" || !this.client.enabled) {
      return baseline;
    }
    if (this.mode === "shadow") {
      // Never on the caller's critical path: ask, compare, log, move on.
      void this.consult(spec, input).then((outcome) => this.record(spec, baseline, baseline, "rule", outcome));
      return baseline;
    }
    const outcome = await this.consult(spec, input);
    if (outcome.value !== undefined) {
      this.record(spec, baseline, outcome.value, "jev", outcome);
      return outcome.value;
    }
    this.record(spec, baseline, baseline, "rule_fallback", outcome);
    return baseline;
  }

  private async consult<Input, Output>(
    spec: DecisionSpec<Input, Output>,
    input: Input,
  ): Promise<{ value?: Output; confidence?: number; latencyMs?: number; reason?: string }> {
    if (!this.client.isReady) {
      return { reason: "not_ready" };
    }
    const started = this.now();
    try {
      const { state, questions } = spec.buildRequest(input);
      const response = await this.client.ask(state, questions, { timeoutMs: spec.budgetMs });
      const latencyMs = this.now() - started;
      const interpreted = spec.interpret(response, input);
      if (!interpreted) return { latencyMs, reason: "low_confidence" };
      return { value: interpreted.value, confidence: interpreted.confidence, latencyMs };
    } catch (error) {
      return { latencyMs: this.now() - started, reason: error instanceof JevError ? error.kind : "error" };
    }
  }

  private record<Input, Output>(
    spec: DecisionSpec<Input, Output>,
    baseline: Output,
    chosen: Output,
    source: DecisionSource,
    outcome: { value?: Output; confidence?: number; latencyMs?: number; reason?: string },
  ): void {
    const jev = outcome.value === undefined ? undefined : spec.describe(outcome.value);
    const baselineLabel = spec.describe(baseline);
    try {
      this.onRecord({
        decision: spec.name,
        version: spec.version,
        mode: this.mode,
        source,
        chosen: spec.describe(chosen),
        baseline: baselineLabel,
        agreed: jev === undefined ? undefined : jev === baselineLabel,
        jev,
        confidence: outcome.confidence,
        latencyMs: outcome.latencyMs,
        fallbackReason: outcome.value === undefined ? outcome.reason : undefined,
      });
    } catch {
      // Auditing must never disturb the decision it describes.
    }
  }
}
