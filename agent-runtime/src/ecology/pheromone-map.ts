/**
 * Pheromone Map: the swarm's reinforcement-learning-flavored memory of which
 * paths (task-feature -> role success rate, role+model latency, tool-path
 * outcomes) have actually worked, keyed separately per device/network
 * context -- design doc section 12.2.
 *
 * Every method here is deterministic and synchronous, exactly like
 * ProsperityScore.calculate()/Queen.evaluate() elsewhere in this package:
 * no model call, no I/O. Persistence is in-memory for this task (mirrors
 * ./gene-bank.ts and ./population.ts's own documented choice for this same
 * task generation); the natural seam for real SQLite persistence is one row
 * per PheromoneEntry in the `pheromones` table ../storage/migrations.ts
 * already created -- see ../storage/db-worker.ts's "task.assimilate"
 * command, the first caller to actually persist a pheromone delta (one row)
 * as part of a task's terminal-state transaction.
 *
 * "Path" is deliberately one generic key shape (PheromonePathKey) rather
 * than separate types for "task-feature -> role" vs. "tool path": design
 * doc 12.2 lists both as things this map tracks, and a tool path is really
 * just a taskFeature string naming a tool instead of a capability (e.g.
 * "tool:mail_send" vs. "mail.send") -- callers decide what the string
 * means, this module only ever keys and weights it. Different device/
 * network contexts are always part of the key (PheromoneContext): this
 * module never assumes a path's success on one device or network says
 * anything about another, per design doc 12.2 and this task's own spec.
 *
 * reinforce()/penalize()/decay() all require an explicit `nowMs` on every
 * call -- no internal `Date.now()` fallback anywhere in this file -- so
 * decay() (which reasons about elapsed time since a path was last touched)
 * is fully testable with a fake clock, never real waiting. This mirrors
 * ./queen.ts's `evaluateOnCadence(nowMs, ...)` more closely than the
 * constructor-injected `now: () => Date` pattern used by TaskNest/
 * CapabilityGateway/RuntimeMetrics, because every one of THIS module's
 * mutating calls (not just a cadence wrapper) needs its own timestamp.
 */

export interface PheromoneContext {
  /** Device this observation happened on (e.g. "iphone-15", "macbook-pro"). */
  readonly deviceId: string;
  /** Network this observation happened on (e.g. "home-wifi", "cellular"). */
  readonly networkId: string;
}

export interface PheromonePathKey {
  /** The task-feature, capability, or tool this path is about (e.g. "mail.send", "tool:mail_send"). See the module doc comment for why this is one generic string rather than separate types. */
  readonly taskFeature: string;
  readonly roleId: string;
  /** Optional model identifier -- role+model combination latency is tracked as a genuinely different path per design doc 12.2, even for the same taskFeature/roleId/context. */
  readonly modelId?: string;
  readonly context: PheromoneContext;
}

export interface PheromoneEntry {
  readonly path: PheromonePathKey;
  /** Current effective weight, always in [0, 1]. Higher means "more trusted to route to again." */
  readonly weight: number;
  readonly successes: number;
  readonly failures: number;
  readonly userCorrections: number;
  readonly lastVerifiedAt: string;
  readonly averageLatencyMs: number | undefined;
  readonly latencySampleCount: number;
}

export class InvalidPheromonePathError extends Error {
  constructor(reason: string) {
    super(`invalid pheromone path: ${reason}`);
    this.name = "InvalidPheromonePathError";
  }
}

export interface PheromoneMapOptions {
  /** How much of the remaining distance to 1.0 a single reinforce() closes. Default 0.2. */
  readonly reinforceStep?: number;
  /** Fraction of current weight a single ordinary failure removes. Default 0.15. */
  readonly ordinaryFailureStep?: number;
  /** Fraction of current weight a single user correction removes -- must stay well above ordinaryFailureStep; design doc 8.4's "用户纠正会明显降低对应路径的信息素权重". Default 0.6. */
  readonly userCorrectionStep?: number;
  /** Half-life used by decay(): how long (ms) it takes an unused path's weight to fall by half. Default 7 days. */
  readonly decayHalfLifeMs?: number;
}

const DEFAULT_REINFORCE_STEP = 0.2;
const DEFAULT_ORDINARY_FAILURE_STEP = 0.15;
const DEFAULT_USER_CORRECTION_STEP = 0.6;
const DEFAULT_DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Real Unit Separator control character -- practically impossible to collide with a human-authored taskFeature/roleId/device/network id, so canonicalKey() never has to worry about one component's delimiter appearing inside another's value. */
const KEY_SEPARATOR = "";

interface MutableEntry {
  path: PheromonePathKey;
  weight: number;
  successes: number;
  failures: number;
  userCorrections: number;
  lastVerifiedAtMs: number;
  lastDecayedAtMs: number;
  latencyTotalMs: number;
  latencySampleCount: number;
}

export interface ReinforceOptions {
  readonly latencyMs?: number;
}

export interface PenalizeOptions {
  /** True when this failure is specifically a user correction (see the class doc comment) rather than an ordinary task/tool failure. Default false. */
  readonly userCorrection?: boolean;
}

export interface PheromoneRankFilter {
  readonly taskFeature?: string;
  readonly roleId?: string;
}

export class PheromoneMap {
  private readonly reinforceStep: number;
  private readonly ordinaryFailureStep: number;
  private readonly userCorrectionStep: number;
  private readonly decayHalfLifeMs: number;
  private readonly entries = new Map<string, MutableEntry>();

  constructor(options: PheromoneMapOptions = {}) {
    this.reinforceStep = options.reinforceStep ?? DEFAULT_REINFORCE_STEP;
    this.ordinaryFailureStep = options.ordinaryFailureStep ?? DEFAULT_ORDINARY_FAILURE_STEP;
    this.userCorrectionStep = options.userCorrectionStep ?? DEFAULT_USER_CORRECTION_STEP;
    this.decayHalfLifeMs = options.decayHalfLifeMs ?? DEFAULT_DECAY_HALF_LIFE_MS;
  }

  /** Records a success on `path`, raising its weight -- an exponential approach toward 1.0 (each call closes `reinforceStep` of the remaining distance), never overshooting it. */
  reinforce(path: PheromonePathKey, nowMs: number, options: ReinforceOptions = {}): PheromoneEntry {
    const entry = this.getOrCreate(path, nowMs);
    entry.successes += 1;
    entry.weight = clamp01(entry.weight + this.reinforceStep * (1 - entry.weight));
    entry.lastVerifiedAtMs = nowMs;
    entry.lastDecayedAtMs = nowMs;
    if (options.latencyMs !== undefined) {
      entry.latencyTotalMs += options.latencyMs;
      entry.latencySampleCount += 1;
    }
    return toPublicEntry(entry);
  }

  /** Records a failure on `path`, lowering its weight -- a user correction (options.userCorrection) removes `userCorrectionStep` of the current weight, an ordinary failure only `ordinaryFailureStep`; the former is always configured to be much sharper (see the class doc comment). */
  penalize(path: PheromonePathKey, nowMs: number, options: PenalizeOptions = {}): PheromoneEntry {
    const entry = this.getOrCreate(path, nowMs);
    if (options.userCorrection) {
      entry.userCorrections += 1;
      entry.weight = clamp01(entry.weight * (1 - this.userCorrectionStep));
    } else {
      entry.failures += 1;
      entry.weight = clamp01(entry.weight * (1 - this.ordinaryFailureStep));
    }
    entry.lastVerifiedAtMs = nowMs;
    entry.lastDecayedAtMs = nowMs;
    return toPublicEntry(entry);
  }

  /**
   * Applies time-based decay to every known path's weight, based on elapsed
   * time since it was last reinforced/penalized/decayed (whichever is most
   * recent) -- an exponential falloff with half-life `decayHalfLifeMs`.
   * `nowMs` is the only source of "now" this method ever consults; calling
   * it twice with the same `nowMs` is a no-op the second time (elapsed is 0
   * relative to the just-updated internal decay marker).
   */
  decay(nowMs: number): void {
    for (const entry of this.entries.values()) {
      const elapsedMs = nowMs - entry.lastDecayedAtMs;
      if (elapsedMs <= 0) {
        continue;
      }
      const factor = Math.pow(0.5, elapsedMs / this.decayHalfLifeMs);
      entry.weight = clamp01(entry.weight * factor);
      entry.lastDecayedAtMs = nowMs;
    }
  }

  /** Current entry for `path`, or undefined if it has never been reinforced/penalized. */
  get(path: PheromonePathKey): PheromoneEntry | undefined {
    const entry = this.entries.get(canonicalKey(path));
    return entry ? toPublicEntry(entry) : undefined;
  }

  /** Every known path matching `filter` (or all of them, with no filter), ordered by current effective weight descending; ties broken by most-recently-verified first. */
  rank(filter: PheromoneRankFilter = {}): readonly PheromoneEntry[] {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          (filter.taskFeature === undefined || entry.path.taskFeature === filter.taskFeature) &&
          (filter.roleId === undefined || entry.path.roleId === filter.roleId),
      )
      .sort((a, b) => b.weight - a.weight || b.lastVerifiedAtMs - a.lastVerifiedAtMs)
      .map(toPublicEntry);
  }

  private getOrCreate(path: PheromonePathKey, nowMs: number): MutableEntry {
    validatePath(path);
    const key = canonicalKey(path);
    const existing = this.entries.get(key);
    if (existing) {
      return existing;
    }
    const created: MutableEntry = {
      path,
      weight: 0,
      successes: 0,
      failures: 0,
      userCorrections: 0,
      lastVerifiedAtMs: nowMs,
      lastDecayedAtMs: nowMs,
      latencyTotalMs: 0,
      latencySampleCount: 0,
    };
    this.entries.set(key, created);
    return created;
  }
}

function validatePath(path: PheromonePathKey): void {
  if (path.taskFeature.trim() === "") {
    throw new InvalidPheromonePathError("taskFeature must be non-empty");
  }
  if (path.roleId.trim() === "") {
    throw new InvalidPheromonePathError("roleId must be non-empty");
  }
  if (path.context.deviceId.trim() === "") {
    throw new InvalidPheromonePathError("context.deviceId must be non-empty");
  }
  if (path.context.networkId.trim() === "") {
    throw new InvalidPheromonePathError("context.networkId must be non-empty");
  }
}

/** Canonical string key for a path -- built field-by-field (never JSON.stringify(path)) so key equality never depends on object key insertion order. */
function canonicalKey(path: PheromonePathKey): string {
  return [path.taskFeature, path.roleId, path.modelId ?? "*", path.context.deviceId, path.context.networkId].join(
    KEY_SEPARATOR,
  );
}

function toPublicEntry(entry: MutableEntry): PheromoneEntry {
  return Object.freeze({
    path: entry.path,
    weight: entry.weight,
    successes: entry.successes,
    failures: entry.failures,
    userCorrections: entry.userCorrections,
    lastVerifiedAt: new Date(entry.lastVerifiedAtMs).toISOString(),
    averageLatencyMs: entry.latencySampleCount > 0 ? entry.latencyTotalMs / entry.latencySampleCount : undefined,
    latencySampleCount: entry.latencySampleCount,
  });
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Role lifecycle (promotion/retirement) decisions -- design doc section 8.4.
// Co-located with PheromoneMap (rather than a new file) because 8.4 bundles
// the pheromone-weight-from-corrections rule with these same promotion/
// sleep/release rules as one paragraph, and because this task's own file
// list gives PheromoneMap, not ../ecology/gene-bank.ts, room for one more
// small, pure export. Exactly like Queen.evaluate() and
// RoleIncubator.propose(), evaluateRoleLifecycle() only ever produces a
// structured decision -- it never touches a live PiRoleSessionManager
// session or a GeneBank entry itself; applying the decision is a later
// orchestration task's job (see the class doc comments on Queen and
// RoleIncubator for the same, already-established split).
// ---------------------------------------------------------------------------

export type RoleLifecycleAction = "promote_resident" | "sleep" | "release_session_keep_gene" | "no_change";

export interface RoleLifecycleDecision {
  readonly action: RoleLifecycleAction;
  readonly reason: string;
}

/** Everything evaluateRoleLifecycle() needs, as plain already-observed counters -- mirrors ./queen.ts's EcologySnapshot in spirit (the caller assembles this from real history; this function never looks anything up itself). */
export interface RoleExperienceSnapshot {
  /** Successful reuses of this role across DISTINCT tasks since its last promotion (or since birth). Design doc 8.4: "在不同任务中成功复用三次". */
  readonly crossTaskSuccessCount: number;
  /** Current run of consecutive task failures (resets to 0 on any success). Design doc 8.4: "连续失败两次". */
  readonly consecutiveFailures: number;
  /** Whether any of those cross-task successes was accompanied by a serious incident (e.g. a diplomacy escalation, a verification failure that reached the user). A role with incidents never promotes on count alone. */
  readonly hadSeriousIncident: boolean;
  /** When this role was last actually used, in epoch ms. */
  readonly lastUsedAtMs: number;
}

export interface RoleLifecycleEvaluationOptions {
  readonly nowMs: number;
  /** How long (ms) a role may sit unused before it's flagged for release-session-keep-gene. Default 14 days. */
  readonly longUnusedThresholdMs?: number;
}

const PROMOTION_SUCCESS_THRESHOLD = 3;
const SLEEP_CONSECUTIVE_FAILURE_THRESHOLD = 2;
const DEFAULT_LONG_UNUSED_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Pure, deterministic mapping from one role's observed experience to a
 * lifecycle decision, in this priority order (design doc 8.4; safety-
 * relevant signals are checked first -- mirrors CapabilityGateway's own
 * "never fail open" fail-safe ordering):
 *   1. `consecutiveFailures` at or past the sleep threshold -> "sleep",
 *      regardless of any success count also present.
 *   2. `crossTaskSuccessCount` at or past the promotion threshold AND no
 *      serious incident -> "promote_resident".
 *   3. Unused for at least `longUnusedThresholdMs` -> "release_session_keep_gene".
 *   4. Otherwise -> "no_change".
 */
export function evaluateRoleLifecycle(
  snapshot: RoleExperienceSnapshot,
  options: RoleLifecycleEvaluationOptions,
): RoleLifecycleDecision {
  if (snapshot.consecutiveFailures >= SLEEP_CONSECUTIVE_FAILURE_THRESHOLD) {
    return Object.freeze({
      action: "sleep" as const,
      reason: `${snapshot.consecutiveFailures} consecutive failures reached the sleep threshold of ${SLEEP_CONSECUTIVE_FAILURE_THRESHOLD}`,
    });
  }

  if (snapshot.crossTaskSuccessCount >= PROMOTION_SUCCESS_THRESHOLD && !snapshot.hadSeriousIncident) {
    return Object.freeze({
      action: "promote_resident" as const,
      reason: `${snapshot.crossTaskSuccessCount} successful cross-task reuses with no serious incident`,
    });
  }

  const longUnusedThresholdMs = options.longUnusedThresholdMs ?? DEFAULT_LONG_UNUSED_THRESHOLD_MS;
  const idleMs = options.nowMs - snapshot.lastUsedAtMs;
  if (idleMs >= longUnusedThresholdMs) {
    return Object.freeze({
      action: "release_session_keep_gene" as const,
      reason: `unused for ${idleMs}ms, at or past the ${longUnusedThresholdMs}ms long-unused threshold`,
    });
  }

  return Object.freeze({ action: "no_change" as const, reason: "no lifecycle threshold crossed" });
}
