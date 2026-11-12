/**
 * The per-turn decision: for one final user transcript, what should the
 * runtime do? One Jev request answers every question that applies, in
 * parallel (speculative fan-out), and the rest of the runtime keeps consuming
 * the same `RouteDecision` it always did:
 *
 *   intent          -- new request, stop talking, cancel / steer / follow up the
 *                      running task (the options offered depend on whether a
 *                      task is running).
 *   role            -- which specialist should take a new request, chosen from
 *                      the roles that exist right now, by their routingHint.
 *   pending_answer  -- only when the runtime is waiting for a yes/no (a drafted
 *                      email): is this utterance that answer?
 *   ack             -- D6, the ack gate: can Marcus answer right away, after one
 *                      quick lookup, or only after long work? Decides whether a
 *                      "let me check" is spoken first (../voice/ack-gate.ts). It
 *                      has its own off/shadow/live switch, so it can be
 *                      calibrated while the routing questions stay live.
 *
 * The deterministic ReflexRouter stays in charge of two things: explicit
 * stop/cancel commands ("取消", "闭嘴") are obeyed instantly without asking
 * anyone, and whenever Jev is unreachable, slow, or unsure, the rule's answer
 * is used. See ./decision-engine.ts for the modes.
 *
 * The thresholds below are the only place "how sure is sure enough" lives.
 * They are starting points to be calibrated from shadow-mode logs
 * (`scripts/query-hci-events.sh --decisions`), not truths: confidence
 * summarizes how concentrated the distribution is, not whether it is right.
 */

import type { RouteDecision, RouteState } from "../routing/reflex-router.js";
import { ReflexRouter } from "../routing/reflex-router.js";
import { classifyAckByRule, type AckNeed } from "../voice/ack-gate.js";
import type { DecisionEngine, DecisionMode, DecisionRecord, DecisionSpec } from "./decision-engine.js";
import type { JevQuestion, JevResponse } from "./jev-client.js";

export type AnswerKind = "confirm" | "decline" | "unrelated" | "unclear";

export interface RoleMenuItem {
  readonly roleId: string;
  /** Plain-language description of what the role is for; it is what Jev reads, so it carries the routing meaning. */
  readonly hint: string;
}

export interface PendingQuestion {
  /** What the runtime is waiting for a yes/no on, in words ("send 'hi' to a@b.com"). */
  readonly summary: string;
  /** The role that asked, and so the one that should hear the answer. */
  readonly roleId: string;
}

export interface TurnInput {
  readonly transcript: string;
  readonly active?: { readonly taskId: string; readonly roleId?: string; readonly goal?: string };
  readonly roles: readonly RoleMenuItem[];
  readonly pending?: PendingQuestion;
}

export interface TurnOutcome {
  readonly route: RouteDecision;
  /** Present only when a confirmation was pending. */
  readonly answer?: AnswerKind;
  /** Jev's reading of how soon the turn can be answered; set only when the outcome came from Jev. */
  readonly jevAck?: AckNeed;
  /** The ack need the caller should act on, after the ack gate's own mode is applied (see TurnDecider). */
  readonly ack?: AckNeed;
}

/** Probability the top option must reach before Jev may override the rule, per outcome. */
export const TURN_THRESHOLDS = {
  /** A new request is the default reading; it needs only modest certainty. */
  new_request: 0.6,
  /** Abandoning or silencing work the user may still want: demand more. */
  cancel_task: 0.85,
  stop_speaking: 0.85,
  steer_task: 0.75,
  follow_up: 0.75,
  /** Which specialist handles a new request. */
  role: 0.6,
  /** Treating an utterance as consent to an irreversible action: demand a lot. */
  confirm: 0.9,
  decline: 0.6,
  unrelated: 0.6,
  /** How soon the turn can be answered (D6). Below this the 700 ms rule applies. */
  ack: 0.6,
} as const;

const ACK_CRITERIA: Record<string, string> = {
  immediate:
    "Marcus can answer right away from conversation or general knowledge: a greeting, small talk, thanks, an opinion, an explanation, a question about Marcus himself.",
  quick:
    "Marcus must first do one quick thing that takes a few seconds: one web search (weather, a price, a fact), check the inbox, check a service's status.",
  long:
    "Marcus needs extended work before answering: research across several sources, a multi-step task, writing or summarizing something long -- tens of seconds or more.",
};

/** Jev's answer to the ack question, or undefined when it is not sure enough. */
function interpretAck(response: JevResponse): AckNeed | undefined {
  const ack = response.choices["ack"];
  if (!ack) return undefined;
  const top = topOf(ack.probabilities);
  if (top.p < TURN_THRESHOLDS.ack) return undefined;
  return top.name === "immediate" || top.name === "quick" || top.name === "long" ? top.name : undefined;
}

// A confirmation must be nothing BUT agreement. Matching only a prefix would
// read "好像要下雨" ("looks like rain") as consent, so every clause of the
// utterance has to be a whole agreement phrase.
const AGREEMENT = /^(好的?|好吧|行|行吧|可以的?|确认|确定|发吧|发送|发出去|去吧|对|对的|是的?|嗯|没问题|同意|允许|批准|ok(ay)?|yes|yeah|sure|go ahead|confirm(ed)?|send( it)?)[啊呀吧嘛哦]?$/i;
const DECLINE_RULE = /^(算了|不用了|不要|别发|不发|先不|取消|不行|不可以|不同意|不允许|拒绝|no\b|don'?t\b|cancel|never ?mind|stop\b)/i;

/**
 * The deterministic reading of an answer to a pending question. It can say
 * "confirm" only for a short, unmistakable agreement and treats everything
 * else as unclear -- the safe direction for an irreversible action.
 */
export function classifyAnswerByRule(transcript: string): AnswerKind {
  const clauses = transcript
    .split(/[，。,.!！?？;；]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");
  if (clauses.length === 0) return "unclear";
  if (clauses.some((clause) => DECLINE_RULE.test(clause))) return "decline";
  if (clauses.length <= 4 && clauses.every((clause) => AGREEMENT.test(clause))) return "confirm";
  return "unclear";
}

/** An answer that is not "unrelated" belongs to whoever asked, so it goes back to them rather than to a general worker. */
function routeAnswerToAsker(route: RouteDecision, answer: AnswerKind | undefined, pending: PendingQuestion | undefined): RouteDecision {
  if (!pending || answer === undefined || answer === "unrelated") return route;
  if (route.kind !== "general_worker" && route.kind !== "capability_match") return route;
  return {
    kind: "capability_match",
    text: route.text,
    roleId: pending.roleId,
    matchedCapability: "pending_confirmation",
    reason: `utterance answers the pending question for role "${pending.roleId}"`,
  };
}

function topOf(probabilities: Readonly<Record<string, number>>): { name: string; p: number } {
  let best = { name: "", p: -1 };
  for (const [name, p] of Object.entries(probabilities)) {
    if (p > best.p) best = { name, p };
  }
  return best;
}

function intentCriteria(hasActiveTask: boolean): Record<string, string> {
  const criteria: Record<string, string> = {
    new_request:
      "The user asks for something new or just talks: a question, a task, small talk, a greeting, or anything not about the running task.",
    stop_speaking: "The user wants Marcus to stop talking right now (e.g. '别说了', 'be quiet') without abandoning any work.",
  };
  if (hasActiveTask) {
    criteria["cancel_task"] =
      "The user wants the running task abandoned and nothing done instead (e.g. 'forget it', '算了不用查了').";
    criteria["steer_task"] =
      "The user corrects or redirects the running task right now: a changed detail, an added constraint, 'no, make it ...'.";
    criteria["follow_up"] = "The user wants something done AFTER the running task finishes, building on its result.";
  }
  return criteria;
}

export const turnDecisionSpec: DecisionSpec<TurnInput, TurnOutcome> = {
  name: "turn",
  // 2: added the D6 `ack` question.
  version: "2",
  budgetMs: 700,

  buildRequest(input) {
    const state = {
      user_utterance: input.transcript,
      running_task: input.active ? { handled_by: input.active.roleId ?? "unknown", goal: input.active.goal ?? "" } : null,
      waiting_for_user_answer: input.pending ? { proposed_action: input.pending.summary } : null,
    };
    const questions: Record<string, JevQuestion> = {
      intent: {
        type: "choice",
        instructions: "What does the user want to happen as a result of this utterance?",
        criteria: intentCriteria(input.active !== undefined),
      },
      role: {
        type: "choice",
        instructions: "If this is a request, which specialist is best placed to handle it?",
        criteria: Object.fromEntries(input.roles.map((role) => [role.roleId, role.hint])),
      },
    };
    questions["ack"] = {
      type: "choice",
      instructions: "How soon can Marcus start giving a real answer to this utterance?",
      criteria: ACK_CRITERIA,
    };
    if (input.pending) {
      questions["pending_answer"] = {
        type: "choice",
        instructions: "Marcus asked the user to approve `waiting_for_user_answer.proposed_action`. Is the utterance an answer to that?",
        criteria: {
          confirm: "The user clearly agrees to go ahead with exactly the proposed action (e.g. '好，发吧', 'yes send it').",
          decline: "The user refuses, cancels, or wants to change what was proposed (e.g. '算了', '不要发', '改一下标题').",
          unrelated: "The utterance does not answer the question: it is a different request or small talk.",
          unclear: "It might be an answer, but it is too vague to tell whether the user agrees.",
        },
      };
    }
    return { state, questions };
  },

  interpret(response: JevResponse, input: TurnInput) {
    const intent = response.choices["intent"];
    const role = response.choices["role"];
    if (!intent || !role) return undefined;

    let answer: AnswerKind | undefined;
    const pendingAnswer = response.choices["pending_answer"];
    if (input.pending) {
      if (!pendingAnswer) return undefined;
      const p = pendingAnswer.probabilities;
      if ((p["confirm"] ?? 0) >= TURN_THRESHOLDS.confirm) answer = "confirm";
      else if ((p["decline"] ?? 0) >= TURN_THRESHOLDS.decline) answer = "decline";
      else if ((p["unrelated"] ?? 0) >= TURN_THRESHOLDS.unrelated) answer = "unrelated";
      else answer = "unclear";
    }

    // A decisive answer to the pending question settles the turn on its own:
    // "先别发" is plainly a refusal even if the general intent reads as muddled
    // (0.51), and the answer goes back to whoever asked either way.
    if (input.pending && (answer === "confirm" || answer === "decline")) {
      const route: RouteDecision = {
        kind: "capability_match",
        text: input.transcript,
        roleId: input.pending.roleId,
        matchedCapability: "pending_confirmation",
        reason: `jev: utterance ${answer === "confirm" ? "confirms" : "declines"} the pending question for role "${input.pending.roleId}"`,
      };
      return { value: { route, answer, jevAck: interpretAck(response) }, confidence: pendingAnswer?.probabilities[answer] ?? 0 };
    }

    const top = topOf(intent.probabilities);
    const needed = (TURN_THRESHOLDS as Record<string, number>)[top.name];
    if (needed === undefined || top.p < needed) return undefined;

    const taskId = input.active?.taskId;
    let route: RouteDecision;
    let confidence = top.p;
    switch (top.name) {
      case "stop_speaking":
        route = { kind: "stop_speech", text: input.transcript, taskId, reason: `jev: user wants Marcus to stop talking (p=${top.p.toFixed(2)})` };
        break;
      case "cancel_task":
        route = { kind: "cancel", text: input.transcript, taskId, reason: `jev: user abandons the running task (p=${top.p.toFixed(2)})` };
        break;
      case "steer_task":
        route = { kind: "steer", text: input.transcript, taskId, reason: `jev: user redirects the running task (p=${top.p.toFixed(2)})` };
        break;
      case "follow_up":
        route = { kind: "follow_up", text: input.transcript, taskId, reason: `jev: user queues a follow-up (p=${top.p.toFixed(2)})` };
        break;
      default: {
        const chosen = topOf(role.probabilities);
        if (chosen.p < TURN_THRESHOLDS.role) return undefined;
        confidence = Math.min(confidence, chosen.p);
        route =
          chosen.name === "general"
            ? { kind: "general_worker", text: input.transcript, roleId: "general", reason: `jev: general request (p=${chosen.p.toFixed(2)})` }
            : {
                kind: "capability_match",
                text: input.transcript,
                roleId: chosen.name,
                matchedCapability: "jev",
                reason: `jev: best specialist is "${chosen.name}" (p=${chosen.p.toFixed(2)})`,
              };
      }
    }
    return { value: { route: routeAnswerToAsker(route, answer, input.pending), answer, jevAck: interpretAck(response) }, confidence };
  },

  describe(outcome) {
    return `${outcome.route.kind}:${outcome.route.roleId ?? "-"}${outcome.answer ? `/${outcome.answer}` : ""}`;
  },
};

export interface TurnDeciderOptions {
  readonly engine: DecisionEngine;
  readonly reflex?: ReflexRouter;
  /**
   * The ack gate's own rollout switch, independent of the routing decision's:
   * `off` keeps the old unconditional 700 ms ack ("unknown"), `shadow` acts on
   * the rule (classifyAckByRule) while Jev's reading is logged next to it,
   * `live` acts on Jev's reading when it gave a confident one. Default `off`.
   */
  readonly ackMode?: DecisionMode;
  /** Receives one audit record per turn for the ack gate (decision "ack_gate"). */
  readonly onAckRecord?: (record: DecisionRecord) => void;
}

export const ACK_GATE_DECISION = "ack_gate";
export const ACK_GATE_VERSION = "1";

export class TurnDecider {
  private readonly engine: DecisionEngine;
  private readonly reflex: ReflexRouter;
  private readonly ackMode: DecisionMode;
  private readonly onAckRecord: (record: DecisionRecord) => void;

  constructor(options: TurnDeciderOptions) {
    this.engine = options.engine;
    this.reflex = options.reflex ?? new ReflexRouter();
    this.ackMode = options.ackMode ?? "off";
    this.onAckRecord = options.onAckRecord ?? ((): void => {});
  }

  async decide(input: TurnInput, routeState: RouteState): Promise<TurnOutcome> {
    const rule = this.reflex.route(input.transcript, routeState);
    const ruleAnswer = input.pending ? classifyAnswerByRule(input.transcript) : undefined;

    // Explicit commands are obeyed on the spot: no network, no second opinion.
    if (rule.kind === "stop_speech" || rule.kind === "cancel") {
      return { route: rule, answer: ruleAnswer };
    }

    const baseline: TurnOutcome = { route: routeAnswerToAsker(rule, ruleAnswer, input.pending), answer: ruleAnswer };
    const outcome = await this.engine.decide(turnDecisionSpec, input, baseline);
    return { ...outcome, ack: this.gateAck(input.transcript, outcome.jevAck) };
  }

  /** Applies the ack gate's mode to the rule's and Jev's readings, and audits the choice. */
  private gateAck(transcript: string, jevAck: AckNeed | undefined): AckNeed {
    if (this.ackMode === "off") return "unknown";
    const ruleAck = classifyAckByRule(transcript);
    const useJev = this.ackMode === "live" && jevAck !== undefined;
    const chosen = useJev ? jevAck : ruleAck;
    try {
      this.onAckRecord({
        decision: ACK_GATE_DECISION,
        version: ACK_GATE_VERSION,
        mode: this.ackMode,
        source: useJev ? "jev" : this.ackMode === "live" ? "rule_fallback" : "rule",
        chosen,
        baseline: ruleAck,
        agreed: jevAck === undefined ? undefined : jevAck === ruleAck,
        jev: jevAck,
        confidence: undefined,
        latencyMs: undefined,
        // The routing decision's own record carries Jev's latency and any fallback reason.
        fallbackReason: jevAck === undefined ? "no_jev_reading" : undefined,
      });
    } catch {
      // Auditing must never disturb the decision it describes.
    }
    return chosen;
  }
}
