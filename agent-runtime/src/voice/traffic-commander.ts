/**
 * Traffic Commander: the sidecar's cadence controller for local, synthetic
 * speech -- receipt acknowledgements and real-progress utterances. It does
 * not decide WHAT the agent should do (that's Reflex Router/Stress
 * Judge/the role's own Pi Session) and it does not fabricate content: a
 * progress utterance only ever repeats a `phase` label the caller already
 * observed as real state, per
 * .proj-init/02-swarm-agent-architecture-for-realtime-voice.md's "Traffic
 * Commander 只生成短进度反馈，不替 Worker 编造结果" rule.
 *
 * Deliberately owns no timer of its own. `evaluate()` is a pure function of
 * (task snapshot, current time) -- the caller (a later, out-of-scope
 * orchestrator task) is expected to invoke it on every new snapshot and on
 * a short idle poll, matching this task's "self-contained, independently
 * testable, state passed in as data" mandate. This also makes every
 * threshold in this file testable with plain numbers, no fake timers
 * required.
 *
 * Default thresholds match Task 10 step 5 of
 * .proj-init/05-autonomous-swarm-voice-agent-development-action-plan.md:
 *   - No ack within 700ms of a final transcript -> one local receipt ack.
 *   - Task still running with no speakable state for 3s -> one real
 *     progress utterance.
 *   - Minimum 5s gap between progress utterances for the same task.
 *   - No phase change -> no repeated utterance.
 */

import type { SpeechDirective } from "./voice-herald.js";

export interface TrafficTaskSnapshot {
  readonly taskId: string;
  /** Whether the task is still actively running (not completed/failed/cancelled). */
  readonly running: boolean;
  /**
   * ms timestamp (same clock as `nowMs` passed to evaluate()) of the most
   * recent final transcript that has not yet been acknowledged. Pass
   * `undefined` once acked by any means -- this class's own bookkeeping
   * also suppresses re-firing for the same timestamp (see evaluate()), so
   * it is safe to keep passing the same value across repeated calls.
   */
  readonly finalTranscriptAtMs?: number;
  /**
   * The real, speakable phase/status label for the task's current state
   * (e.g. "running tests"), current as of `phaseChangedAtMs`. Must reflect
   * an actual observed state change -- this class never invents one. Leave
   * both `phase` and `phaseChangedAtMs` undefined when there is nothing new
   * to report.
   */
  readonly phase?: string;
  readonly phaseChangedAtMs?: number;
}

export interface TrafficCommanderOptions {
  /** Grace period after a final transcript before a local receipt ack fires. Default 700ms. */
  readonly ackGraceMs?: number;
  /** How long a real phase must sit unspoken before the FIRST progress utterance for a task. Default 3000ms. */
  readonly progressSilenceMs?: number;
  /** Minimum gap between two progress utterances for the same task. Default 5000ms. */
  readonly minProgressGapMs?: number;
  /** Canned receipt-ack text. Default a short, generic Chinese acknowledgement. */
  readonly receiptText?: string;
  /** Builds the spoken text for a progress utterance from the real `phase` label. Default wraps it in a short fixed template. */
  readonly formatProgress?: (phase: string) => string;
}

interface TaskBookkeeping {
  ackedFinalTranscriptAtMs: number | undefined;
  lastProgressSpokenAtMs: number | undefined;
  lastSpokenPhase: string | undefined;
}

const DEFAULT_ACK_GRACE_MS = 700;
const DEFAULT_PROGRESS_SILENCE_MS = 3_000;
const DEFAULT_MIN_PROGRESS_GAP_MS = 5_000;
const DEFAULT_RECEIPT_TEXT = "好的，我在处理。";

function defaultFormatProgress(phase: string): string {
  return `还在处理：${phase}`;
}

export class TrafficCommander {
  private readonly ackGraceMs: number;
  private readonly progressSilenceMs: number;
  private readonly minProgressGapMs: number;
  private readonly receiptText: string;
  private readonly formatProgress: (phase: string) => string;
  private readonly tasks = new Map<string, TaskBookkeeping>();

  constructor(options: TrafficCommanderOptions = {}) {
    this.ackGraceMs = options.ackGraceMs ?? DEFAULT_ACK_GRACE_MS;
    this.progressSilenceMs = options.progressSilenceMs ?? DEFAULT_PROGRESS_SILENCE_MS;
    this.minProgressGapMs = options.minProgressGapMs ?? DEFAULT_MIN_PROGRESS_GAP_MS;
    this.receiptText = options.receiptText ?? DEFAULT_RECEIPT_TEXT;
    this.formatProgress = options.formatProgress ?? defaultFormatProgress;
  }

  /**
   * Decides whether something should be spoken for `snapshot` right now.
   * Returns at most one directive per call -- a receipt ack always takes
   * priority over a progress utterance on the same call (both firing on
   * the same tick is vanishingly rare, and receipt is the more
   * time-sensitive of the two). Returns `null` when nothing should be said.
   */
  evaluate(snapshot: TrafficTaskSnapshot, nowMs: number): SpeechDirective | null {
    const book = this.bookkeepingFor(snapshot.taskId);

    const receipt = this.evaluateReceipt(snapshot, nowMs, book);
    if (receipt) {
      return receipt;
    }

    return this.evaluateProgress(snapshot, nowMs, book);
  }

  /** Releases bookkeeping for a task once it reaches a terminal state, so this Map never grows unbounded across a long-running process. */
  forget(taskId: string): void {
    this.tasks.delete(taskId);
  }

  private evaluateReceipt(
    snapshot: TrafficTaskSnapshot,
    nowMs: number,
    book: TaskBookkeeping,
  ): SpeechDirective | null {
    if (snapshot.finalTranscriptAtMs === undefined) {
      return null;
    }
    if (book.ackedFinalTranscriptAtMs === snapshot.finalTranscriptAtMs) {
      return null; // already acked this exact final transcript
    }
    if (nowMs - snapshot.finalTranscriptAtMs < this.ackGraceMs) {
      return null; // still within grace; some other real response may still preempt this
    }

    book.ackedFinalTranscriptAtMs = snapshot.finalTranscriptAtMs;
    return { kind: "receipt", text: this.receiptText, taskId: snapshot.taskId };
  }

  private evaluateProgress(
    snapshot: TrafficTaskSnapshot,
    nowMs: number,
    book: TaskBookkeeping,
  ): SpeechDirective | null {
    if (!snapshot.running || snapshot.phase === undefined || snapshot.phaseChangedAtMs === undefined) {
      return null;
    }
    if (snapshot.phase === book.lastSpokenPhase) {
      return null; // no phase change -> no repeated utterance
    }

    const gateMs = book.lastProgressSpokenAtMs === undefined ? this.progressSilenceMs : this.minProgressGapMs;
    const sinceMs = nowMs - (book.lastProgressSpokenAtMs ?? snapshot.phaseChangedAtMs);
    if (sinceMs < gateMs) {
      return null;
    }

    book.lastProgressSpokenAtMs = nowMs;
    book.lastSpokenPhase = snapshot.phase;
    return { kind: "progress", text: this.formatProgress(snapshot.phase), taskId: snapshot.taskId };
  }

  private bookkeepingFor(taskId: string): TaskBookkeeping {
    let book = this.tasks.get(taskId);
    if (!book) {
      book = { ackedFinalTranscriptAtMs: undefined, lastProgressSpokenAtMs: undefined, lastSpokenPhase: undefined };
      this.tasks.set(taskId, book);
    }
    return book;
  }
}
