/**
 * Voice Herald: the sole gatekeeper for what reaches TTS. Converts
 * structured backend RealtimeEvents into short, speakable SpeechDirectives
 * -- or rejects them outright. Every other module in this sidecar that
 * wants something spoken must go through here (see the plan's Global
 * Constraints: "Chain-of-thought, raw tool logs, JSON/debug info, code
 * blocks, long paths/URLs/lists, and unverified intermediate conclusions
 * must NEVER be spoken. Voice Herald is the sole gatekeeper for what
 * reaches TTS.").
 *
 * Two layers of defense, per
 * .proj-init/04-autonomous-swarm-voice-agent-software-design.md section
 * 10.6 ("Voice Herald 只能朗读: 接收确认 / 真实进度变化 / 最终结果摘要 /
 * 升权请求 / 预算、错误和冬眠状态"):
 *
 *   1. Event-type allowlist: only receipt/progress/final/elevation/
 *      budget/error/hibernation-shaped events are ever considered. Raw
 *      tool events (`tool.*`), the user's own transcripts, and internal
 *      plumbing (`task.steer`, `task.follow_up`, `role.*`) are rejected by
 *      type alone, before any payload is even inspected -- see the
 *      `default` branch of accept().
 *   2. Content safety, for the allowlisted event types that carry
 *      free-form agent text (`task.progress`, `task.completed`,
 *      `task.failed`): rejected outright (never "cleaned up" and spoken
 *      partially -- silence is always safer than guessing at a "safe"
 *      subset) if it looks like a code block, raw JSON, a long URL/path, an
 *      over-long dump, or an unverified/hedge-language conclusion. See
 *      isForbiddenContent().
 *
 * Pure and synchronous: accept() never calls a model, never awaits, and
 * never accumulates state (it holds none).
 *
 * One deliberate exception to layer 2: `voice.speech.enqueue` events shaped
 * like `{ payload: { kind: "local_prompt", promptKey } }` (e.g. the Queen's
 * hard-hibernation "usage_exhausted" prompt, design doc 7.4/8.4) skip
 * isForbiddenContent() entirely -- see acceptLocalPromptEnqueue() and
 * LOCAL_PROMPT_TEXT. This is safe specifically because the text is a fixed,
 * pre-approved phrase a human already wrote, never free-form agent output,
 * so there is nothing for the content-safety gate to check.
 */

import type { RealtimeEvent } from "../protocol/events.js";

export const SPEECH_DIRECTIVE_KINDS = [
  "receipt",
  "progress",
  "final",
  "elevation",
  "budget",
  "error",
  "hibernation",
] as const;
export type SpeechDirectiveKind = (typeof SPEECH_DIRECTIVE_KINDS)[number];

export interface SpeechDirective {
  readonly kind: SpeechDirectiveKind;
  readonly text: string;
  readonly taskId?: string;
}

/**
 * The four ecology/food states from
 * .proj-init/04-autonomous-swarm-voice-agent-software-design.md section
 * 7.3. Declared locally (not imported) to keep this module self-contained
 * and independently testable -- the real `FoodState` type lives in a
 * later, not-yet-built Upkeep Meter task.
 */
const FOOD_STATES = ["prosperous", "conserving", "reserve", "hibernating"] as const;
type FoodState = (typeof FOOD_STATES)[number];

const MAX_SPEAKABLE_LENGTH = 160;
const MAX_INLINE_FRAGMENT_LENGTH = 40;

const CODE_FENCE_PATTERN = /```/;
const JSON_ENVELOPE_PATTERN = /^\s*[[{][\s\S]*[\]}]\s*$/;
const JSON_KEY_PATTERN = /"[^"\\]{1,64}"\s*:/g;
const LONG_URL_PATTERN = /\bhttps?:\/\/\S{20,}/i;
const LONG_PATH_PATTERN = /(?:[\w.-]+\/){3,}[\w.-]*/;
const UNVERIFIED_MARKERS = [
  "可能是",
  "我猜",
  "初步结论",
  "待验证",
  "还未验证",
  "未经验证",
  "尚未确认",
  "preliminary conclusion",
  "not yet verified",
  "unverified",
  "i think it might",
];

const RECEIPT_TEXT = "好的，我在处理。";
const CANCEL_ACK_TEXT = "好的，已经取消了。";
const DEFAULT_COMPLETED_TEXT = "已经完成了。";
const DEFAULT_FAILED_TEXT = "遇到问题，任务失败了。";
const DEFAULT_ELEVATION_ACTION = "这个操作";
const DEFAULT_ELEVATION_IMPACT = "尚不确定的范围";
const DEFAULT_ELEVATION_RESOLVED_TEXT = "好的，升权请求已经处理。";

const BUDGET_TEXT: Record<FoodState, string> = {
  prosperous: "预算充足。",
  conserving: "预算偏紧，我会减少非必要的尝试。",
  reserve: "预算进入保留模式，我会优先处理重要任务。",
  hibernating: "预算已经耗尽，我先进入休眠，基本对话仍然可用。",
};
const DEFAULT_BUDGET_TEXT = "预算状态已更新。";

const ECOLOGY_TEXT: Record<FoodState, string> = {
  prosperous: "系统状态良好。",
  conserving: "系统进入节省模式，我会优先处理重要任务。",
  reserve: "系统资源紧张，我会优先处理重要任务。",
  hibernating: "系统进入休眠，基本对话仍然可用。",
};
const DEFAULT_ECOLOGY_TEXT = "系统状态已更新。";

/**
 * Fixed, pre-approved local phrases for `voice.speech.enqueue` events shaped
 * like `{ payload: { kind: "local_prompt", promptKey } }` -- see
 * acceptLocalPromptEnqueue(). Each entry is canned text a human already
 * reviewed, never free-form agent output, so these deliberately skip
 * isForbiddenContent()'s content-safety gate entirely (there is no
 * unverified/unbounded text here to guard against). An unrecognized
 * promptKey is never guessed at -- see acceptLocalPromptEnqueue() returning
 * null for anything not in this table.
 */
const LOCAL_PROMPT_TEXT: Record<string, string> = {
  // Hard hibernation (food state "hibernating", design doc 7.4/7.6/8.4): the
  // swarm stops thinking entirely -- no Pi prompt of any kind runs, so this
  // is the one thing that can still be said, at zero provider cost.
  usage_exhausted: "使用额度已经用完，系统进入完全休眠，请稍后再试。",
};

export class VoiceHerald {
  /**
   * Converts one backend RealtimeEvent into a SpeechDirective, or `null` if
   * it must never be spoken. See the class doc comment for the two-layer
   * policy this implements.
   */
  accept(event: RealtimeEvent): SpeechDirective | null {
    switch (event.type) {
      case "task.created":
      case "task.assigned":
        return { kind: "receipt", text: RECEIPT_TEXT, taskId: event.task_id };

      case "task.cancelled":
        return { kind: "receipt", text: CANCEL_ACK_TEXT, taskId: event.task_id };

      case "task.progress":
        return this.acceptProgress(event);

      case "task.completed":
        return this.acceptCompleted(event);

      case "task.failed":
        return this.acceptFailed(event);

      case "diplomacy.elevation.requested":
        return { kind: "elevation", text: buildElevationRequestText(event.payload), taskId: event.task_id };

      case "diplomacy.elevation.resolved":
        return { kind: "elevation", text: DEFAULT_ELEVATION_RESOLVED_TEXT, taskId: event.task_id };

      case "budget.updated":
        return {
          kind: "budget",
          text: textForState(readFoodState(event.payload.state), BUDGET_TEXT, DEFAULT_BUDGET_TEXT),
          taskId: event.task_id,
        };

      case "ecology.state.changed":
        return {
          kind: "hibernation",
          text: textForState(readFoodState(event.payload.state), ECOLOGY_TEXT, DEFAULT_ECOLOGY_TEXT),
          taskId: event.task_id,
        };

      case "voice.speech.enqueue":
        return this.acceptLocalPromptEnqueue(event);

      default:
        // voice.user.started/stopped, voice.transcript.partial/final,
        // voice.speech.cancel: transport control or the user's own words,
        // never echoed back.
        // tool.started/completed/failed: raw tool logs -- categorically
        // forbidden regardless of payload content (see the class doc
        // comment's layer 1).
        // task.steer/task.follow_up: the inbound instruction itself, not
        // an outbound status -- the user just said it.
        // role.birth.requested/hatched/slept/retired: internal population
        // bookkeeping, not part of the allowed-to-speak list.
        return null;
    }
  }

  /**
   * The one voice.speech.enqueue shape this class ever speaks: a fixed,
   * pre-approved local phrase (see LOCAL_PROMPT_TEXT), keyed by
   * `payload.promptKey`, when `payload.kind === "local_prompt"`. Bypasses
   * isForbiddenContent() entirely -- unlike task.progress/completed/failed,
   * this text is never free-form agent output, so there is nothing to
   * content-check. Every other voice.speech.enqueue payload (unrecognized
   * kind, unrecognized/missing promptKey) returns null, same as this event
   * type did before this case existed.
   */
  private acceptLocalPromptEnqueue(event: RealtimeEvent): SpeechDirective | null {
    if (event.payload.kind !== "local_prompt") {
      return null;
    }
    const promptKey = readString(event.payload.promptKey);
    const text = promptKey ? LOCAL_PROMPT_TEXT[promptKey] : undefined;
    if (text === undefined) {
      return null;
    }
    return { kind: "hibernation", text, taskId: event.task_id };
  }

  private acceptProgress(event: RealtimeEvent): SpeechDirective | null {
    const text = readString(event.payload.text);
    if (text === undefined || isForbiddenContent(text)) {
      return null;
    }
    return { kind: "progress", text: text.trim(), taskId: event.task_id };
  }

  private acceptCompleted(event: RealtimeEvent): SpeechDirective {
    const summary = readString(event.payload.summary);
    if (summary !== undefined && !isForbiddenContent(summary)) {
      return { kind: "final", text: summary.trim(), taskId: event.task_id };
    }
    return { kind: "final", text: DEFAULT_COMPLETED_TEXT, taskId: event.task_id };
  }

  private acceptFailed(event: RealtimeEvent): SpeechDirective {
    const reason = readString(event.payload.reason) ?? readString(event.payload.message);
    if (reason !== undefined && !isForbiddenContent(reason)) {
      return { kind: "error", text: reason.trim(), taskId: event.task_id };
    }
    return { kind: "error", text: DEFAULT_FAILED_TEXT, taskId: event.task_id };
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readFoodState(value: unknown): FoodState | undefined {
  return typeof value === "string" && (FOOD_STATES as readonly string[]).includes(value)
    ? (value as FoodState)
    : undefined;
}

function textForState(state: FoodState | undefined, table: Record<FoodState, string>, fallback: string): string {
  return state ? table[state] : fallback;
}

/** Collapses to one line and truncates with an ellipsis, so text interpolated into a template can never smuggle in a newline (which would break `.` -based regex matching downstream) or blow past a short-utterance budget. */
function clampInline(text: string, maxLength: number = MAX_INLINE_FRAGMENT_LENGTH): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}

function buildElevationRequestText(payload: Record<string, unknown>): string {
  const action = clampInline(readString(payload.action) ?? readString(payload.summary) ?? DEFAULT_ELEVATION_ACTION);
  const impact = clampInline(readString(payload.impact) ?? readString(payload.scope) ?? DEFAULT_ELEVATION_IMPACT);
  // Deliberately contains, in order: 准备 ("about to do") ... 影响 ("might
  // affect") ... 允许 ("is it allowed") -- the exact three-part elevation
  // contract from section 9.4: "Voice Herald 只说明: 准备执行什么 / 可能影响
  // 什么 / 是否允许。"
  return `准备执行${action}，可能影响${impact}，是否允许？`;
}

/**
 * Content-safety gate for free-form agent text that would otherwise be
 * spoken verbatim (task.progress/task.completed/task.failed payloads).
 * Deliberately conservative: any signal that text might be a code block,
 * raw JSON/debug dump, a long URL/path, an over-long list, or an
 * unverified/hedge-language conclusion rejects the whole string outright
 * rather than trying to strip/sanitize it.
 */
function isForbiddenContent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SPEAKABLE_LENGTH) {
    return true;
  }
  if (CODE_FENCE_PATTERN.test(trimmed)) {
    return true;
  }
  if (JSON_ENVELOPE_PATTERN.test(trimmed)) {
    return true;
  }
  if (countMatches(trimmed, JSON_KEY_PATTERN) >= 2) {
    return true;
  }
  if (LONG_URL_PATTERN.test(trimmed)) {
    return true;
  }
  if (LONG_PATH_PATTERN.test(trimmed)) {
    return true;
  }
  if ((trimmed.match(/\n/g)?.length ?? 0) >= 3) {
    return true; // long multi-line dump / list
  }
  const lower = trimmed.toLowerCase();
  if (UNVERIFIED_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) {
    return true;
  }
  return false;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}
