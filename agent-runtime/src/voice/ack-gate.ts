/**
 * Ack gate (D6 in docs/spec/duplex-voice-architecture.md §5 ⑤): should the
 * agent say "let me check" before its real answer, and in what words?
 *
 * The old behavior was unconditional: 700 ms after a final transcript with
 * nothing said yet, speak a templated ack. That produced "嗯，我先看看" before
 * answering "你好", and "我查一下" before introducing itself -- an ack that
 * announces an action that is never going to happen.
 *
 * The gate classifies how long the answer needs (`AckNeed`) and turns that,
 * plus the role the turn was routed to, into an `AckPlan`:
 *
 *   immediate -- greetings, small talk, things answerable right away: no ack.
 *                A late safety net still says "嗯，稍等" if the answer is slow
 *                to start, because silence past a few seconds reads as broken.
 *   quick     -- one tool call first: an ack whose verb matches the action.
 *   long      -- extended work: say so up front.
 *   unknown   -- the old 700 ms rule, still worded from the routed action.
 *
 * The need comes from Jev (one more question in the turn decision's single
 * call, see ../decision/turn-decision.ts) with `classifyAckByRule` as the
 * baseline; the wording is always local templates (./ack-generator.ts), never
 * an LLM.
 */

import type { AckAction } from "./ack-generator.js";

export type AckNeed = "immediate" | "quick" | "long" | "unknown";

export const ACK_NEEDS: readonly AckNeed[] = ["immediate", "quick", "long", "unknown"];

export interface AckPlan {
  /** How long after the final transcript the ack may fire, if nothing real has been said by then. */
  readonly delayMs: number;
  readonly action: AckAction;
}

export interface AckPlanOptions {
  /** The normal grace before an ack. Default 700 ms. */
  readonly graceMs?: number;
  /** For an `immediate` turn: how long a silence is tolerated before the neutral safety-net ack. Default 2500 ms. */
  readonly immediateSafetyMs?: number;
}

const DEFAULT_GRACE_MS = 700;
const DEFAULT_IMMEDIATE_SAFETY_MS = 2_500;

// Things a person answers without going anywhere: greetings, thanks, asking
// who Marcus is. Whole-utterance only, so "你好，帮我查下天气" is not small talk.
const SMALL_TALK =
  /^(?:(?:你好|您好|嗨|哈喽|hi|hello|hey|早上好|上午好|中午好|下午好|晚上好|早安|晚安|谢谢|谢谢你|多谢|辛苦了|好的|好|嗯|在吗|在不在|你在吗)[啊呀呢吧哦嘛]?[，,。.!！?？\s]*)+$/i;
const SELF_QUESTION = /(?:介绍(?:一下)?你?自己|你是谁|你叫什么|你能做什么|你会什么|你有什么功能)/;

/**
 * The deterministic reading: a greeting or a question about Marcus himself
 * needs no ack. Everything else is "unknown" -- the rule does not guess which
 * requests are quick or long.
 */
export function classifyAckByRule(transcript: string): AckNeed {
  const text = transcript.trim();
  if (text === "") return "unknown";
  if (SMALL_TALK.test(text)) return "immediate";
  if (SELF_QUESTION.test(text) && text.length <= 20) return "immediate";
  return "unknown";
}

/** The ack's verb from the role a turn was routed to. */
export function actionForRole(roleId: string | undefined): AckAction {
  switch (roleId) {
    case "web":
      return "lookup";
    case "mail":
      return "mail";
    case "device":
    case "inspector":
      return "device";
    case "general":
    case undefined:
      return "think";
    default:
      return "look";
  }
}

export function planAck(need: AckNeed, roleId: string | undefined, options: AckPlanOptions = {}): AckPlan {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  switch (need) {
    case "immediate":
      return { delayMs: Math.max(graceMs, options.immediateSafetyMs ?? DEFAULT_IMMEDIATE_SAFETY_MS), action: "neutral" };
    case "long":
      return { delayMs: graceMs, action: "long" };
    case "quick":
    case "unknown":
      return { delayMs: graceMs, action: actionForRole(roleId) };
  }
}
