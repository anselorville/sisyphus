/**
 * Reflex Router: the sidecar's hot-path decision point for every
 * STT-final transcript. Combines InterruptionRouter's explicit-phrase
 * classification with elevation-dialog handling, capability-tag matching,
 * and Stress Judge escalation, in the fixed priority order from
 * .proj-init/05-autonomous-swarm-voice-agent-development-action-plan.md
 * (Task 10, step 4):
 *
 *   1. Explicit stop/cancel phrases (immediate control, always wins).
 *   2. An answer to the currently-open elevation (authorization) dialog.
 *   3. Explicit steer/follow-up phrases against the current task.
 *   4. Capability-tag match against a known role.
 *   5. Stress Judge escalation.
 *   6. General Worker fallback.
 *
 * Every step is synchronous, allocation-light, and driven entirely by plain
 * data passed in through `state` -- this class never calls a model, never
 * imports role/task-nest modules, and never blocks. See the perf benchmark
 * in test/routing/reflex-router.test.ts for the p95 budget this is held to
 * (<2ms on a dev machine, leaving headroom under the <10ms design target
 * measured on real Raspberry Pi hardware).
 *
 * Note on ordering: an explicit "取消" (cancel) phrase always wins over an
 * open elevation dialog (priority 1 beats priority 2) -- a user who says
 * "cancel" gets a reliable, unconditional escape hatch regardless of what
 * dialog is open, even mid-elevation-approval. A user who wants to *reject*
 * the elevation instead says "不允许"/"拒绝"/etc., which does not match the
 * cancel phrase set and is handled at priority 2.
 */

import type { ActiveTaskRef } from "./interruption-router.js";
import { InterruptionRouter, matchPhraseSet } from "./interruption-router.js";
import type { PhraseSet } from "./interruption-router.js";
import type { StressDecision, StressSignals } from "./stress-judge.js";
import { StressJudge } from "./stress-judge.js";

export const ROUTE_DECISION_KINDS = [
  "stop_speech",
  "cancel",
  "elevation_response",
  "steer",
  "follow_up",
  "capability_match",
  "stress_escalation",
  "general_worker",
] as const;
export type RouteDecisionKind = (typeof ROUTE_DECISION_KINDS)[number];

/** A one-time authorization dialog currently open for this conversation, awaiting a yes/no answer. */
export interface PendingElevation {
  readonly requestId: string;
  readonly taskId?: string;
}

/** A role offering a set of capability tags ReflexRouter can match a new/unrelated request against. Tags are matched as case-insensitive substrings of the transcript -- see matchCapability(). Provider order is match priority (first hit wins). */
export interface CapabilityProvider {
  readonly roleId: string;
  readonly capabilities: readonly string[];
}

export interface RouteState {
  readonly activeTask?: ActiveTaskRef;
  readonly pendingElevation?: PendingElevation;
  readonly capabilityProviders?: readonly CapabilityProvider[];
  /** Role id the General Worker fallback assigns to. Mirrors roles/manifests.ts's GENERAL_ROLE_MANIFEST.id ("general") without importing that module, keeping this router self-contained and independently testable. */
  readonly generalWorkerRoleId?: string;
  /** Pre-computed Stress Judge inputs; ReflexRouter never derives these itself (see ./stress-judge.ts). */
  readonly stress?: StressSignals;
}

export interface RouteDecision {
  readonly kind: RouteDecisionKind;
  /** The original transcript, carried through for downstream consumers. */
  readonly text: string;
  readonly taskId?: string;
  readonly roleId?: string;
  /** Set only for kind === "elevation_response". */
  readonly approved?: boolean;
  /** Set only for kind === "capability_match". */
  readonly matchedCapability?: string;
  /** Set only for kind === "stress_escalation". */
  readonly stressDecision?: StressDecision;
  /** Diagnostic-only explanation of why this decision was made -- logs/telemetry only. Must never be forwarded to Voice Herald or TTS. */
  readonly reason: string;
}

export interface ReflexRouterOptions {
  readonly interruptionRouter?: InterruptionRouter;
  readonly stressJudge?: StressJudge;
}

const DEFAULT_GENERAL_WORKER_ROLE_ID = "general";

const ELEVATION_DENY_PHRASES: PhraseSet = {
  exact: ["别", "不行", "拒绝", "no", "deny"],
  contains: ["不允许", "不可以", "不同意", "不要", "别这样", "别做", "don't", "do not", "reject it", "deny it", "no way"],
};

const ELEVATION_APPROVE_PHRASES: PhraseSet = {
  exact: ["行", "可以", "好", "好的", "同意", "允许", "确认", "批准", "yes", "ok", "okay", "sure"],
  contains: ["可以的", "没问题", "去吧", "批准了", "go ahead", "approve it", "confirmed", "sounds good"],
};

export class ReflexRouter {
  private readonly interruptionRouter: InterruptionRouter;
  private readonly stressJudge: StressJudge;

  constructor(options: ReflexRouterOptions = {}) {
    this.interruptionRouter = options.interruptionRouter ?? new InterruptionRouter();
    this.stressJudge = options.stressJudge ?? new StressJudge();
  }

  route(transcript: string, state: RouteState = {}): RouteDecision {
    const interruption = this.interruptionRouter.classify(transcript, state.activeTask);

    // Tier 1: explicit stop/cancel, unconditional.
    if (interruption.kind === "stop_speech") {
      return { kind: "stop_speech", text: transcript, taskId: interruption.taskId, reason: "explicit stop phrase" };
    }
    if (interruption.kind === "cancel") {
      return { kind: "cancel", text: transcript, taskId: interruption.taskId, reason: "explicit cancel phrase" };
    }

    // Tier 2: an answer to the currently-open elevation dialog.
    const elevationAnswer = this.matchElevationAnswer(transcript, state.pendingElevation);
    if (elevationAnswer) {
      return elevationAnswer;
    }

    // Tier 3: explicit steer/follow-up against the active task.
    if (interruption.kind === "steer") {
      return {
        kind: "steer",
        text: transcript,
        taskId: interruption.taskId,
        reason: "explicit correction phrase against active task",
      };
    }
    if (interruption.kind === "follow_up") {
      return {
        kind: "follow_up",
        text: transcript,
        taskId: interruption.taskId,
        reason: "explicit follow-up phrase against active task",
      };
    }

    // interruption.kind === "new_task" from here on.

    // Tier 4: capability-tag match.
    const capability = this.matchCapability(transcript, state.capabilityProviders ?? []);
    if (capability) {
      return {
        kind: "capability_match",
        text: transcript,
        roleId: capability.roleId,
        matchedCapability: capability.tag,
        reason: `capability tag "${capability.tag}" matched role "${capability.roleId}"`,
      };
    }

    // Tier 5: Stress Judge escalation.
    const stressDecision = this.stressJudge.assess(state.stress);
    if (stressDecision !== "stay_baseline") {
      return {
        kind: "stress_escalation",
        text: transcript,
        stressDecision,
        reason: `stress judge escalated to "${stressDecision}"`,
      };
    }

    // Tier 6: General Worker fallback.
    return {
      kind: "general_worker",
      text: transcript,
      roleId: state.generalWorkerRoleId ?? DEFAULT_GENERAL_WORKER_ROLE_ID,
      reason: "no explicit phrase, capability match, or stress escalation applied",
    };
  }

  private matchElevationAnswer(
    transcript: string,
    pending: PendingElevation | undefined,
  ): RouteDecision | undefined {
    if (!pending) {
      return undefined;
    }

    // Deny checked before approve: some deny phrases ("不可以", "不行", "不允许")
    // contain an approve phrase as a substring ("可以", "行", "允许"). Checking
    // the full deny list first, before ever consulting the approve list,
    // resolves that ambiguity correctly regardless of phrase order.
    const denyHit = matchPhraseSet(transcript, ELEVATION_DENY_PHRASES);
    if (denyHit) {
      return {
        kind: "elevation_response",
        text: transcript,
        taskId: pending.taskId,
        approved: false,
        reason: `elevation denial phrase "${denyHit}" matched pending request ${pending.requestId}`,
      };
    }

    const approveHit = matchPhraseSet(transcript, ELEVATION_APPROVE_PHRASES);
    if (approveHit) {
      return {
        kind: "elevation_response",
        text: transcript,
        taskId: pending.taskId,
        approved: true,
        reason: `elevation approval phrase "${approveHit}" matched pending request ${pending.requestId}`,
      };
    }

    return undefined;
  }

  private matchCapability(
    transcript: string,
    providers: readonly CapabilityProvider[],
  ): { roleId: string; tag: string } | undefined {
    const normalized = transcript.toLowerCase();
    for (const provider of providers) {
      for (const tag of provider.capabilities) {
        if (tag.length > 0 && normalized.includes(tag.toLowerCase())) {
          return { roleId: provider.roleId, tag };
        }
      }
    }
    return undefined;
  }
}
