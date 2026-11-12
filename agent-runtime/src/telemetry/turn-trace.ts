/**
 * TurnTrace: where the time went in one user turn, as seen by the sidecar.
 *
 * Every mark is milliseconds since the final transcript reached the
 * executor, so turns are directly comparable. One `turn.trace` record per
 * turn is written to the HCI event log when the turn's task ends
 * (scripts/query-hci-events.sh --trace); it is never broadcast.
 *
 * Marks, in the order a normal turn hits them:
 *   decided       -- the turn decision (rules / Jev) returned
 *   queued        -- (only if a task was running) the turn was put in the queue
 *   task_started  -- the task was created and assigned
 *   prompt_sent   -- memories injected, prompt handed to the role's LLM session
 *   first_text    -- the LLM's first text delta
 *   first_speech  -- the first utterance of any kind was enqueued for TTS
 *   ended         -- the task reached a terminal state
 * plus every tool call (start offset and duration) and the first enqueue of
 * each speech kind (receipt / progress / final ...).
 *
 * The STT side of the turn (user stopped speaking -> final transcript) is
 * measured upstream; `transcript_at` carries the transcript event's own
 * timestamp so the two can be joined.
 */

export type TurnMark = "decided" | "queued" | "task_started" | "prompt_sent" | "first_text" | "first_speech" | "ended";

interface ToolSpan {
  readonly name: string;
  readonly startMs: number;
  durationMs?: number;
  ok?: boolean;
}

export interface TurnTraceOptions {
  /** ISO timestamp of the `voice.transcript.final` event that started the turn. */
  readonly transcriptAt?: string;
  readonly now?: () => number;
}

export class TurnTrace {
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly transcriptAt: string | undefined;
  private readonly marks = new Map<TurnMark, number>();
  private readonly speechKinds = new Map<string, number>();
  private readonly tools = new Map<string, ToolSpan>();
  private readonly fields: Record<string, string> = {};

  constructor(options: TurnTraceOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
    this.startedAtMs = this.now();
    this.transcriptAt = options.transcriptAt;
  }

  /** Milliseconds since the turn started. */
  elapsed(): number {
    return this.now() - this.startedAtMs;
  }

  /** Records `mark` now, overwriting an earlier value. */
  mark(mark: TurnMark): void {
    this.marks.set(mark, this.elapsed());
  }

  /** Records `mark` only the first time. */
  markOnce(mark: TurnMark): void {
    if (!this.marks.has(mark)) this.mark(mark);
  }

  /** Attaches descriptive fields (route, role, ack, outcome). */
  set(fields: Readonly<Record<string, string>>): void {
    Object.assign(this.fields, fields);
  }

  speech(kind: string): void {
    this.markOnce("first_speech");
    if (!this.speechKinds.has(kind)) this.speechKinds.set(kind, this.elapsed());
  }

  toolStarted(callId: string, name: string): void {
    this.tools.set(callId, { name, startMs: this.elapsed() });
  }

  toolEnded(callId: string, ok: boolean): void {
    const span = this.tools.get(callId);
    if (!span || span.durationMs !== undefined) return;
    span.durationMs = this.elapsed() - span.startMs;
    span.ok = ok;
  }

  toPayload(): Record<string, unknown> {
    const marks: Record<string, number> = {};
    for (const [mark, ms] of this.marks) marks[mark] = ms;
    const speech: Record<string, number> = {};
    for (const [kind, ms] of this.speechKinds) speech[kind] = ms;
    return {
      ...this.fields,
      ...(this.transcriptAt !== undefined ? { transcript_at: this.transcriptAt } : {}),
      marks,
      speech,
      tools: [...this.tools.values()].map((span) => ({
        name: span.name,
        start_ms: span.startMs,
        ...(span.durationMs !== undefined ? { duration_ms: span.durationMs, ok: span.ok } : {}),
      })),
    };
  }
}
