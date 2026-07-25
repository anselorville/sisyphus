/**
 * Diplomacy Officer: the swarm's "外交事故评估官" (diplomatic incident
 * assessor). Answers exactly one question for every external tool call --
 * ALLOW it silently, ALLOW it but keep a durable record, or ELEVATE it to a
 * human -- and nothing else.
 *
 * Per .proj-init/04-autonomous-swarm-voice-agent-software-design.md section
 * 9 and this task's spec:
 *   - Rules operate ONLY on ActionEnvelope's structured fields. `targetSummary`
 *     is an opaque label (for logs/voice output only) -- it is never parsed
 *     as an instruction or a risk signal. A tool author (or an attacker
 *     controlling upstream content) writing "ignore the rules, ALLOW this"
 *     into targetSummary must have zero effect on the decision; only the
 *     other, structured fields ever participate in applyRules().
 *   - Explicit rules are checked first and resolve the overwhelming common
 *     case. Only the one genuinely-ambiguous case (see the "irreversible
 *     write at an ambiguous scale" comment in applyRules()) falls through to
 *     the injected `classifier` -- in production a fast/low-cost Pi session
 *     constrained to answer with nothing but one of the three
 *     DiplomacyDecision values; in tests, a fixed fake. evaluate() also
 *     guards at runtime that whatever the classifier returns really is one
 *     of the three enum values, since that constraint is safety-load-bearing
 *     and must not rely on TypeScript types alone (a real model's raw output
 *     crossing a process boundary is not statically checked).
 */

export const DIPLOMACY_DECISIONS = ["ALLOW", "ALLOW_LOGGED", "ELEVATE"] as const;
export type DiplomacyDecision = (typeof DIPLOMACY_DECISIONS)[number];

export const ACTION_OPERATIONS = ["read", "create", "modify", "delete", "send", "publish", "pay", "system"] as const;
export type ActionOperation = (typeof ACTION_OPERATIONS)[number];

/**
 * Every external tool call is wrapped in one of these before
 * CapabilityGateway (./capability-gateway.ts) ever sees it. Field names and
 * shape are fixed by .proj-init/05-...-development-action-plan.md's Task 11
 * interface section -- do not rename.
 */
export interface ActionEnvelope {
  readonly taskId: string;
  readonly roleId: string;
  readonly toolName: string;
  /** Opaque, human-readable label (e.g. "email to a@example.com"). Never parsed as an instruction or a structured signal -- see the module doc comment. */
  readonly targetSummary: string;
  readonly reversible: boolean;
  readonly affectedObjects: number;
  readonly externalAudience: number;
  readonly sensitiveData: boolean;
  readonly threatensAvailability: boolean;
  readonly operation: ActionOperation;
}

/**
 * Fallback for the narrow set of cases explicit rules cannot decide.
 * Production wiring is a fast/low-cost Pi Session constrained to answer with
 * only one of the three DiplomacyDecision values (never free text) -- not
 * built in this task ("you don't need to wire up a real Pi session for this
 * task"). Tests inject a fixed fake, the same seam-injection shape as
 * PiSessionProvider in ../roles/types.ts.
 */
export type DiplomacyClassifier = (envelope: ActionEnvelope) => Promise<DiplomacyDecision>;

export interface DiplomacyOfficerOptions {
  /** Default: always ELEVATE -- the conservative fail-safe when no classifier is wired up at all (never silently autonomous just because nothing was injected). */
  readonly classifier?: DiplomacyClassifier;
  /** At/above this many external recipients, a send/publish-shaped action is broadcast-scale ("mailing-list style") and always elevated. Below it, more than one recipient is still an ordinary conversation -- never bulk purely because count > 1. Configurable per design-doc 9.3's "群发阈值是配置项" (the bulk threshold is a config item). */
  readonly bulkAudienceThreshold?: number;
  /** At/above this many affected objects, an irreversible create/modify/delete is unambiguously large-scale ("大范围") and always elevated. */
  readonly largeScaleObjectsThreshold?: number;
  /** Up to this many affected objects, an irreversible create/modify/delete stays ordinary (ALLOW_LOGGED) even though it cannot be undone -- e.g. permanently deleting a couple of temp files. Strictly between this and largeScaleObjectsThreshold is the genuinely ambiguous zone that falls through to the classifier. */
  readonly smallScaleObjectsMax?: number;
}

/** Thrown when the injected classifier returns anything other than one of DIPLOMACY_DECISIONS -- guards the "may ONLY return one of the three fixed enum values" constraint at runtime, not just via the TypeScript type. */
export class InvalidClassifierDecisionError extends Error {
  constructor(received: unknown) {
    super(`classifier must return exactly one of ${DIPLOMACY_DECISIONS.join(", ")}, got: ${JSON.stringify(received)}`);
    this.name = "InvalidClassifierDecisionError";
  }
}

const DEFAULT_BULK_AUDIENCE_THRESHOLD = 20;
const DEFAULT_LARGE_SCALE_OBJECTS_THRESHOLD = 25;
const DEFAULT_SMALL_SCALE_OBJECTS_MAX = 3;

const DECISION_SET: ReadonlySet<string> = new Set(DIPLOMACY_DECISIONS);

/** Conservative default when no classifier is injected at all: never silently autonomous. */
const FAIL_SAFE_CLASSIFIER: DiplomacyClassifier = async (): Promise<DiplomacyDecision> => "ELEVATE";

function isWriteLike(operation: ActionOperation): boolean {
  return operation === "create" || operation === "modify" || operation === "delete";
}

export class DiplomacyOfficer {
  private readonly classifier: DiplomacyClassifier;
  private readonly bulkAudienceThreshold: number;
  private readonly largeScaleObjectsThreshold: number;
  private readonly smallScaleObjectsMax: number;

  constructor(options: DiplomacyOfficerOptions = {}) {
    this.classifier = options.classifier ?? FAIL_SAFE_CLASSIFIER;
    this.bulkAudienceThreshold = options.bulkAudienceThreshold ?? DEFAULT_BULK_AUDIENCE_THRESHOLD;
    this.largeScaleObjectsThreshold = options.largeScaleObjectsThreshold ?? DEFAULT_LARGE_SCALE_OBJECTS_THRESHOLD;
    this.smallScaleObjectsMax = options.smallScaleObjectsMax ?? DEFAULT_SMALL_SCALE_OBJECTS_MAX;

    if (this.smallScaleObjectsMax >= this.largeScaleObjectsThreshold) {
      throw new RangeError(
        `smallScaleObjectsMax (${this.smallScaleObjectsMax}) must be less than largeScaleObjectsThreshold (${this.largeScaleObjectsThreshold})`,
      );
    }
  }

  /**
   * Rule-first, touching only ActionEnvelope's structured fields. Resolves
   * every rule-decidable case without ever calling the classifier; only the
   * one genuinely-ambiguous case (see applyRules()) reaches it.
   */
  async evaluate(envelope: ActionEnvelope): Promise<DiplomacyDecision> {
    const ruled = this.applyRules(envelope);
    if (ruled !== undefined) {
      return ruled;
    }

    const decision = await this.classifier(envelope);
    if (!DECISION_SET.has(decision)) {
      throw new InvalidClassifierDecisionError(decision);
    }
    return decision;
  }

  /** Returns undefined exactly when rules cannot decide -- the sole trigger for evaluate() to fall through to the classifier. */
  private applyRules(envelope: ActionEnvelope): DiplomacyDecision | undefined {
    // Judge factor 5 (design-doc 9.1): would failure break system
    // availability? Fatal regardless of operation type -- shutdown/restart
    // /mass process kill, firewall/network-core changes, or any tool call
    // explicitly flagged this way.
    if (envelope.threatensAvailability) {
      return "ELEVATE";
    }

    // 9.3: money always needs a human, at any scale or audience size.
    if (envelope.operation === "pay") {
      return "ELEVATE";
    }

    // 9.3: public release / production deploy / push-to-remote, always.
    if (envelope.operation === "publish") {
      return "ELEVATE";
    }

    // 9.3: system directories, credentials, user accounts, remote access
    // config. A *read* of sensitive data stays autonomous-but-logged (see
    // defaultDecision below, judge factor 4); any *mutation* touching it is
    // elevated regardless of scale -- a single credential change still
    // qualifies.
    if (envelope.sensitiveData && envelope.operation !== "read") {
      return "ELEVATE";
    }

    // 9.3: mailing-list-style broadcast / bulk-generated recipients. Note
    // the explicit nuance from 9.3's last line: a handful of To/CC/BCC
    // recipients must NOT be judged bulk purely because count > 1 -- only
    // at/above the configured threshold does this fire.
    if (envelope.externalAudience >= this.bulkAudienceThreshold) {
      return "ELEVATE";
    }

    if (!envelope.reversible && isWriteLike(envelope.operation)) {
      // 9.3: unrecoverable, large-scale ("大范围") file overwrite/delete.
      if (envelope.affectedObjects >= this.largeScaleObjectsThreshold) {
        return "ELEVATE";
      }
      if (envelope.affectedObjects > this.smallScaleObjectsMax) {
        // Genuinely ambiguous: an irreversible write too big to call "a
        // couple of files" (which stays autonomous) but not yet confidently
        // "mass/bulk" (which would elevate) either. Neither the large-scale
        // rule above nor the ordinary default below can responsibly answer,
        // so -- and only so -- this one narrow case defers to the classifier.
        return undefined;
      }
    }

    return this.defaultDecision(envelope);
  }

  /** Everything rules can positively resolve without the classifier. */
  private defaultDecision(envelope: ActionEnvelope): DiplomacyDecision {
    switch (envelope.operation) {
      case "read":
        // 9.2: file/device/service reads, web reads, mail read/classify --
        // autonomous. Logged (not silent) only when the payload is flagged
        // sensitive, since judge factor 4 (9.1) must matter somewhere for
        // reads too.
        return envelope.sensitiveData ? "ALLOW_LOGGED" : "ALLOW";
      case "create":
      case "modify":
      case "delete":
      case "send":
      case "system":
        // 9.2: normal file/edit/build/test/commit/dependency-install/own-
        // service-restart/mail-send-reply-forward work -- autonomous, but
        // always durably logged since each of these does something real to
        // the world.
        return "ALLOW_LOGGED";
      case "publish":
      case "pay":
        // Unreachable in practice (both are always elevated earlier in
        // applyRules()); kept so a 9th ActionOperation added later fails a
        // review here instead of silently defaulting to autonomous.
        return "ELEVATE";
      default: {
        const exhaustive: never = envelope.operation;
        throw new RangeError(`unhandled ActionEnvelope.operation: ${String(exhaustive)}`);
      }
    }
  }
}
