/**
 * Memory Curator: decides what a task/conversation event is allowed to
 * become in permanent Personal Memory -- design doc section 12.4, and this
 * task's Global Constraint that full conversations, full tool logs,
 * chain-of-thought/assistant reasoning, and raw email bodies must never
 * automatically become long-term memory, no matter how the event is framed.
 *
 * consider() is deterministic, exactly like Inspector.verify() and
 * ProsperityScore.calculate() elsewhere in this package: no model call, and
 * a single switch over the event's own `kind` -- never free-form content
 * inspection -- decides eligibility. The four excluded kinds
 * (raw_tool_log, email_body, assistant_thinking, raw_conversation) are
 * rejected outright regardless of their content; nothing about how
 * plausible or well-formatted that content looks can move them into
 * `persist: true`.
 *
 * Repetition detection for "observed_preference" (design doc 12.4's "重复
 * 出现且稳定的偏好") is kept deliberately simple: this instance counts how
 * many times each distinct `subjectKey` has been observed across calls to
 * consider(), and only persists once `preferenceRepetitionThreshold`
 * observations have accumulated for that key. No fuzzy matching, no time
 * decay of the count -- a later task can replace this with something
 * richer without changing consider()'s public contract.
 *
 * Whatever this class decides to persist is always run through compress(),
 * which hard-truncates to `maxCompressedLength` -- even an explicit user
 * "remember this" request or a legitimately verified fact never reaches
 * permanent storage as unbounded raw content. This is the module's own
 * belt-and-suspenders enforcement of "never full raw content", on top of
 * the categorical kind-based exclusion above.
 */

export const MEMORY_EVENT_KINDS = [
  "explicit_remember_request",
  "observed_preference",
  "verified_fact",
  "task_result_summary",
  "raw_tool_log",
  "email_body",
  "assistant_thinking",
  "raw_conversation",
  "unverified_claim",
] as const;
export type MemoryEventKind = (typeof MEMORY_EVENT_KINDS)[number];

export interface MemoryEvent {
  readonly kind: MemoryEventKind;
  readonly content: string;
  /** Only meaningful for "observed_preference": a stable grouping key so repeated observations of "the same" preference count toward one another (e.g. "prefers_metric_units"). Falls back to `content` itself when omitted. */
  readonly subjectKey?: string;
  /** Only meaningful for "verified_fact": whether this fact has actually been verified elsewhere. Never assumed true. */
  readonly verified?: boolean;
}

export type MemoryDecisionReason =
  | "explicit_user_request"
  | "verified_fact"
  | "reusable_task_summary"
  | "stable_repeated_preference"
  | "preference_not_yet_stable"
  | "fact_not_verified"
  | "empty_content"
  | "raw_tool_log_excluded"
  | "raw_email_body_excluded"
  | "assistant_reasoning_excluded"
  | "raw_conversation_excluded"
  | "unverified_claim_excluded";

export interface MemoryDecision {
  readonly persist: boolean;
  readonly reason: MemoryDecisionReason;
  /** Only present when persist is true -- the exact, already-compressed text that would be written. Never richer than what compress() produced. */
  readonly compressedContent?: string;
}

export interface MemoryCuratorOptions {
  /** How many times a distinct subjectKey must be observed as "observed_preference" before it counts as stable enough to persist. Default 3. */
  readonly preferenceRepetitionThreshold?: number;
  /** Hard cap on persisted content length; compress() truncates anything longer. Default 280. */
  readonly maxCompressedLength?: number;
}

const DEFAULT_PREFERENCE_REPETITION_THRESHOLD = 3;
const DEFAULT_MAX_COMPRESSED_LENGTH = 280;

export class MemoryCurator {
  private readonly threshold: number;
  private readonly maxLength: number;
  private readonly observationCounts = new Map<string, number>();

  constructor(options: MemoryCuratorOptions = {}) {
    this.threshold = options.preferenceRepetitionThreshold ?? DEFAULT_PREFERENCE_REPETITION_THRESHOLD;
    this.maxLength = options.maxCompressedLength ?? DEFAULT_MAX_COMPRESSED_LENGTH;
  }

  /** See the module doc comment for the full rule set. Always resolves (never rejects) with a MemoryDecision -- an event this curator does not recognize is a programming error (see the exhaustiveness check below), not a runtime "no". */
  async consider(event: MemoryEvent): Promise<MemoryDecision> {
    switch (event.kind) {
      case "raw_tool_log":
        return reject("raw_tool_log_excluded");
      case "email_body":
        return reject("raw_email_body_excluded");
      case "assistant_thinking":
        return reject("assistant_reasoning_excluded");
      case "raw_conversation":
        return reject("raw_conversation_excluded");
      case "unverified_claim":
        return reject("unverified_claim_excluded");

      case "explicit_remember_request":
        return this.isEmpty(event) ? reject("empty_content") : this.accept(event, "explicit_user_request");

      case "verified_fact":
        if (this.isEmpty(event)) {
          return reject("empty_content");
        }
        return event.verified === true ? this.accept(event, "verified_fact") : reject("fact_not_verified");

      case "task_result_summary":
        return this.isEmpty(event) ? reject("empty_content") : this.accept(event, "reusable_task_summary");

      case "observed_preference": {
        if (this.isEmpty(event)) {
          return reject("empty_content");
        }
        const observedCount = this.recordObservation(event);
        return observedCount >= this.threshold
          ? this.accept(event, "stable_repeated_preference")
          : reject("preference_not_yet_stable");
      }

      default: {
        const exhaustive: never = event.kind;
        throw new Error(`unhandled memory event kind: ${String(exhaustive)}`);
      }
    }
  }

  private isEmpty(event: MemoryEvent): boolean {
    return event.content.trim() === "";
  }

  private accept(event: MemoryEvent, reason: MemoryDecisionReason): MemoryDecision {
    return Object.freeze({ persist: true, reason, compressedContent: this.compress(event.content) });
  }

  private recordObservation(event: MemoryEvent): number {
    const key = event.subjectKey ?? event.content;
    const next = (this.observationCounts.get(key) ?? 0) + 1;
    this.observationCounts.set(key, next);
    return next;
  }

  private compress(content: string): string {
    const trimmed = content.trim();
    if (trimmed.length <= this.maxLength) {
      return trimmed;
    }
    return `${trimmed.slice(0, this.maxLength - 1)}…`;
  }
}

function reject(reason: MemoryDecisionReason): MemoryDecision {
  return Object.freeze({ persist: false, reason });
}
