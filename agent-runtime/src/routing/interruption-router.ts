/**
 * Interruption Router: classifies one piece of already STT-finalized user
 * speech against whatever task is currently active, using explicit
 * phrase/keyword rules only. Never calls a model -- this is the fast,
 * deterministic tier ReflexRouter (./reflex-router.ts) leans on for its two
 * highest-priority routing decisions.
 *
 * Matches .proj-init/04-autonomous-swarm-voice-agent-software-design.md
 * section 10.5's interruption-semantics table:
 *   "停、别说了"        -> stop_speech (stop TTS now, background work continues)
 *   "取消这个任务"       -> cancel (stop TTS, abort the Pi Session)
 *   "不是这样，改成……"   -> steer (stop TTS, correct the current Session)
 *   "做完以后再……"       -> follow_up (queue for after the current task)
 *   anything unrelated  -> new_task
 *
 * Priority within this router is fixed: stop_speech beats cancel beats
 * steer beats follow_up beats new_task. stop_speech/cancel are checked
 * unconditionally (interrupting playback or aborting a task is meaningful
 * even with no task in view); steer/follow_up additionally require an
 * `activeTask` to bind to -- without one, "steer/follow-up against the
 * current task" is meaningless, so a matching phrase with no activeTask
 * falls through to `new_task` instead (it is most likely the opening line
 * of a brand-new request that happens to contain corrective wording).
 */

export const INTERRUPTION_KINDS = ["stop_speech", "cancel", "steer", "follow_up", "new_task"] as const;
export type InterruptionKind = (typeof INTERRUPTION_KINDS)[number];

/** Minimal reference to whatever task is currently active in this conversation turn -- just enough for InterruptionRouter to bind steer/follow_up/cancel to it. Supplied by the caller; this module never looks it up itself. */
export interface ActiveTaskRef {
  readonly taskId: string;
  readonly roleId?: string;
}

export interface InterruptionClassification {
  readonly kind: InterruptionKind;
  /** The literal phrase that matched, for logs/telemetry only -- never spoken. Voice Herald (../voice/voice-herald.ts) is the sole TTS gatekeeper and this value never reaches it. */
  readonly matchedPhrase?: string;
  /** Present whenever `kind` refers to an in-flight task (cancel/steer/follow_up). */
  readonly taskId?: string;
}

/**
 * A phrase table split into two match strategies:
 *  - `exact`: matches only when the ENTIRE trimmed utterance (trailing
 *    punctuation stripped) equals one of these. Reserved for short,
 *    otherwise-ambiguous tokens (e.g. "停", "行", "cancel") that would
 *    false-positive as a substring of an unrelated sentence.
 *  - `contains`: matches anywhere in the utterance. Reserved for phrases
 *    distinctive enough not to need the whole-utterance guard.
 */
export interface PhraseSet {
  readonly exact: readonly string[];
  readonly contains: readonly string[];
}

const STOP_SPEECH_PHRASES: PhraseSet = {
  exact: ["停", "停止", "闭嘴", "quiet", "stop", "shut up"],
  contains: ["别说了", "停下来", "停一下", "别讲了", "别念了", "stop talking", "be quiet", "stop speaking"],
};

const CANCEL_PHRASES: PhraseSet = {
  exact: ["取消", "算了", "cancel"],
  contains: [
    "取消这个任务",
    "取消任务",
    "取消这个",
    "不用做了",
    "不用管了",
    "cancel this",
    "cancel the task",
    "never mind",
    "forget it",
  ],
};

const STEER_PHRASES: PhraseSet = {
  exact: [],
  contains: [
    "不是这样",
    "不是这个意思",
    "改成",
    "换成",
    "应该是",
    "更正一下",
    "我是说",
    "actually i meant",
    "change it to",
    "instead of that",
  ],
};

const FOLLOW_UP_PHRASES: PhraseSet = {
  exact: [],
  contains: [
    "做完以后",
    "做完之后",
    "完成以后",
    "完成之后",
    "等你做完",
    "之后再",
    "然后再",
    "顺便再",
    "after you finish",
    "once you're done",
    "after that,",
  ],
};

/** Strips leading/trailing whitespace and trailing punctuation (halfwidth and fullwidth), used to compare a whole utterance against `exact` phrases without being defeated by an STT-added trailing "。"/"." */
function bareText(text: string): string {
  return text.trim().replace(/[，,。.!！?？\s]+$/g, "");
}

export function matchPhraseSet(rawText: string, set: PhraseSet): string | undefined {
  const normalized = rawText.trim().toLowerCase();
  const bare = bareText(rawText).toLowerCase();

  const exactHit = set.exact.find((phrase) => bare === phrase.toLowerCase());
  if (exactHit) {
    return exactHit;
  }
  return set.contains.find((phrase) => normalized.includes(phrase.toLowerCase()));
}

export class InterruptionRouter {
  /**
   * Classifies `text` (a finalized user utterance) against `activeTask`.
   * Pure and synchronous -- safe to call on every STT-final event without
   * ever touching a model or the network.
   */
  classify(text: string, activeTask?: ActiveTaskRef): InterruptionClassification {
    const stopMatch = matchPhraseSet(text, STOP_SPEECH_PHRASES);
    if (stopMatch) {
      return { kind: "stop_speech", matchedPhrase: stopMatch, taskId: activeTask?.taskId };
    }

    const cancelMatch = matchPhraseSet(text, CANCEL_PHRASES);
    if (cancelMatch) {
      return { kind: "cancel", matchedPhrase: cancelMatch, taskId: activeTask?.taskId };
    }

    if (activeTask) {
      const steerMatch = matchPhraseSet(text, STEER_PHRASES);
      if (steerMatch) {
        return { kind: "steer", matchedPhrase: steerMatch, taskId: activeTask.taskId };
      }

      const followUpMatch = matchPhraseSet(text, FOLLOW_UP_PHRASES);
      if (followUpMatch) {
        return { kind: "follow_up", matchedPhrase: followUpMatch, taskId: activeTask.taskId };
      }
    }

    return { kind: "new_task" };
  }
}
