/**
 * Idle-gated filler scheduler for slow tool execution.
 *
 * A filler is only eligible after a tool has remained active for the initial
 * delay. Every real progress event can call `touch()` to restart that idle
 * window. Ending the last active tool or calling `stop()` clears every timer.
 */

export interface LongTaskFillerSchedulerOptions {
  /** Time a tool must remain idle before the first filler. Defaults to 5s. */
  readonly startDelayMs?: number;
  /** Time between fillers while at least one tool remains active. Defaults to 10s. */
  readonly intervalMs?: number;
  /** Local phrases rotated for successive filler utterances. */
  readonly fillerTexts?: readonly string[];
  /** Called synchronously when a filler becomes eligible to speak. */
  readonly onSpeak: (text: string) => void;
}

const DEFAULT_START_DELAY_MS = 5_000;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_FILLER_TEXTS = [
  "还在查，快了。",
  "我再确认一下。",
  "正在处理，稍等。",
  "快好了。",
] as const;

export class LongTaskFillerScheduler {
  private readonly startDelayMs: number;
  private readonly intervalMs: number;
  private readonly fillerTexts: readonly string[];
  private readonly onSpeak: (text: string) => void;
  private readonly activeToolCalls = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cursor = 0;

  constructor(options: LongTaskFillerSchedulerOptions) {
    this.startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.fillerTexts = options.fillerTexts?.length ? options.fillerTexts : DEFAULT_FILLER_TEXTS;
    this.onSpeak = options.onSpeak;

    if (!Number.isFinite(this.startDelayMs) || this.startDelayMs < 0) {
      throw new RangeError("startDelayMs must be a finite non-negative number");
    }
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new RangeError("intervalMs must be a finite positive number");
    }
  }

  /** Starts or joins the idle window for one active tool call. */
  begin(toolCallId: string): void {
    const hadActiveTool = this.activeToolCalls.size > 0;
    this.activeToolCalls.add(toolCallId);
    if (!hadActiveTool) {
      this.schedule(this.startDelayMs);
    }
  }

  /** Ends one tool call and stops scheduling once no tools remain active. */
  end(toolCallId: string): void {
    this.activeToolCalls.delete(toolCallId);
    if (this.activeToolCalls.size === 0) {
      this.clearTimer();
    }
  }

  /** Restarts the idle window after real progress was spoken. */
  touch(): void {
    if (this.activeToolCalls.size > 0) {
      this.schedule(this.startDelayMs);
    }
  }

  /** Cancels all active calls and releases the timer. */
  stop(): void {
    this.activeToolCalls.clear();
    this.clearTimer();
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.activeToolCalls.size === 0) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.activeToolCalls.size === 0) {
        return;
      }
      const text = this.fillerTexts[this.cursor % this.fillerTexts.length];
      this.cursor += 1;
      if (text !== undefined) {
        this.onSpeak(text);
      }
      this.schedule(this.intervalMs);
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
