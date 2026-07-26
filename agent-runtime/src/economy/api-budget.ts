/**
 * API Budget: the pay-as-you-go half of the swarm's food economy (see
 * ./subscription-quota.ts for the other half, and ./types.ts for the shared
 * FoodState vocabulary both are summarized through).
 *
 * Every dollar tracked here belongs to exactly one of two buckets that are
 * NEVER merged into a shared pool:
 *   - the voice survival reserve: money ordinary workers (and the future
 *     Role Incubator / Temporary Intelligence Caste) can never touch. It
 *     exists purely so the system can always afford to tell the user
 *     "budget is low," answer status/cancel queries, and announce recovery,
 *     even at zero ordinary balance.
 *   - the ordinary balance: everything else, available to any worker.
 * See .proj-init/04-autonomous-swarm-voice-agent-software-design.md section
 * 7.2 for the design background.
 *
 * The separation is structural, not a soft convention: availableFor()
 * subtracts voiceReserveUsd before it ever computes a "worker" balance, so
 * there is no code path -- bug or otherwise -- through which a worker's
 * number can include reserve money.
 *
 * Design choices the plan leaves open (see Task 13's own prompt):
 *   - record() creates a provider's tracking state lazily on its first
 *     call, seeded from the single ApiBudgetProviderConfig supplied at
 *     construction -- every provider on one ledger shares that config. A
 *     later task that needs per-provider limits can construct one ledger
 *     per config group instead of extending this one.
 *   - Any other per-provider query (availableFor with an explicit
 *     providerId, foodStateFor, stateFor) throws UnknownProviderError for a
 *     providerId that has never been record()-ed -- "no data yet" is a
 *     different situation from "this provider is at 0%", so we never guess.
 *   - The daily limit really is daily: each provider's spentUsd auto-resets
 *     to 0 once `now()` reaches its nextResetAt (24h after that provider's
 *     first record()), rolling nextResetAt forward by whole-day increments
 *     so a long-idle provider catches up to the correct boundary rather
 *     than drifting.
 *   - foodStateFor's remainingRatio is computed entirely within the
 *     ordinary (non-reserve) capacity -- both numerator and denominator
 *     exclude voiceReserveUsd -- so the reserve is as invisible to
 *     food-state reporting as it is to worker spending.
 *
 * In production this ledger is fed by record(providerId, costUsd) calls
 * driven from a Pi assistant message's own usage data (the `cost.total`
 * field on Pi SDK response objects) -- wiring that up is a later task; this
 * module only needs to accept a plain costUsd number from wherever that
 * usage data ends up surfacing.
 */

import { foodState, type FoodState } from "./types.js";

/** Who is drawing on a provider's budget: an ordinary worker (never the reserve) or the voice survival path (reserve included). */
export type BudgetConsumerRole = "worker" | "voice";

export interface ApiBudgetProviderConfig {
  /** Total dollars a provider may spend per day, reserve included. */
  readonly dailyLimitUsd: number;
  /** Slice of dailyLimitUsd ordinary workers can never draw on. */
  readonly voiceReserveUsd: number;
}

export interface ApiBudgetLedgerOptions extends ApiBudgetProviderConfig {
  /** Injectable clock, mirroring CapabilityGateway's `now` seam -- defaults to the real wall clock. */
  readonly now?: () => Date;
}

/** Read-only snapshot of a single provider's tracked state -- for inspection/telemetry, not for mutating the ledger. */
export interface ApiBudgetProviderState {
  readonly providerId: string;
  readonly dailyLimitUsd: number;
  readonly voiceReserveUsd: number;
  readonly spentUsd: number;
  readonly availableForWorkerUsd: number;
  readonly availableForVoiceUsd: number;
  readonly nextResetAt: string;
  readonly lastUpdatedAt: string;
}

/** Thrown by any per-provider query (availableFor with an explicit providerId, foodStateFor, stateFor) for a providerId that has never been record()-ed. */
export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`no budget tracked yet for provider "${providerId}" (call record() at least once first)`);
    this.name = "UnknownProviderError";
  }
}

interface ProviderEntry {
  spentUsd: number;
  nextResetAtMs: number;
  lastUpdatedAtMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class ApiBudgetLedger {
  private readonly dailyLimitUsd: number;
  private readonly voiceReserveUsd: number;
  private readonly now: () => Date;
  private readonly entries = new Map<string, ProviderEntry>();

  constructor(options: ApiBudgetLedgerOptions) {
    if (!Number.isFinite(options.dailyLimitUsd) || options.dailyLimitUsd < 0) {
      throw new RangeError(`dailyLimitUsd must be a non-negative finite number, got: ${options.dailyLimitUsd}`);
    }
    if (!Number.isFinite(options.voiceReserveUsd) || options.voiceReserveUsd < 0) {
      throw new RangeError(`voiceReserveUsd must be a non-negative finite number, got: ${options.voiceReserveUsd}`);
    }
    this.dailyLimitUsd = options.dailyLimitUsd;
    this.voiceReserveUsd = options.voiceReserveUsd;
    this.now = options.now ?? ((): Date => new Date());
  }

  /** Records `costUsd` spent against `providerId`, creating its tracking state (seeded from this ledger's shared config) on first use. */
  record(providerId: string, costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      throw new RangeError(`costUsd must be a non-negative finite number, got: ${costUsd}`);
    }
    const nowMs = this.now().getTime();
    const entry = this.entryFor(providerId, nowMs);
    entry.spentUsd += costUsd;
    entry.lastUpdatedAtMs = nowMs;
  }

  /**
   * Total dollars `role` may draw on right now: with `providerId` given,
   * just that provider's figure; omitted, the sum across every provider
   * this ledger has seen so far. "worker" can never see reserve money (see
   * the module doc comment); "voice" can spend up to the full daily limit,
   * reserve included, but no more. Never negative -- always clamped at 0.
   */
  availableFor(role: BudgetConsumerRole, providerId?: string): number {
    const nowMs = this.now().getTime();
    if (providerId !== undefined) {
      const entry = this.requireEntry(providerId, nowMs);
      return this.availableForEntry(role, entry);
    }
    let total = 0;
    for (const entry of this.entries.values()) {
      this.resetIfDue(entry, nowMs);
      total += this.availableForEntry(role, entry);
    }
    return total;
  }

  /** The FoodState this provider's own ordinary (non-reserve) remaining ratio maps to. Throws UnknownProviderError if `providerId` has never been record()-ed. */
  foodStateFor(providerId: string): FoodState {
    const nowMs = this.now().getTime();
    const entry = this.requireEntry(providerId, nowMs);
    const ordinaryCapacity = Math.max(0, this.dailyLimitUsd - this.voiceReserveUsd);
    const remainingRatio = ordinaryCapacity <= 0 ? 0 : this.availableForEntry("worker", entry) / ordinaryCapacity;
    return foodState(remainingRatio);
  }

  /** Snapshot of a single provider's tracked state. Throws UnknownProviderError if `providerId` has never been record()-ed. */
  stateFor(providerId: string): ApiBudgetProviderState {
    const nowMs = this.now().getTime();
    const entry = this.requireEntry(providerId, nowMs);
    return Object.freeze({
      providerId,
      dailyLimitUsd: this.dailyLimitUsd,
      voiceReserveUsd: this.voiceReserveUsd,
      spentUsd: entry.spentUsd,
      availableForWorkerUsd: this.availableForEntry("worker", entry),
      availableForVoiceUsd: this.availableForEntry("voice", entry),
      nextResetAt: new Date(entry.nextResetAtMs).toISOString(),
      lastUpdatedAt: new Date(entry.lastUpdatedAtMs).toISOString(),
    });
  }

  /** The one formula that decides what a role may draw on -- kept in a single place so "worker" can never be handed reserve money by accident. */
  private availableForEntry(role: BudgetConsumerRole, entry: ProviderEntry): number {
    if (role === "voice") {
      return Math.max(0, this.dailyLimitUsd - entry.spentUsd);
    }
    return Math.max(0, this.dailyLimitUsd - this.voiceReserveUsd - entry.spentUsd);
  }

  private entryFor(providerId: string, nowMs: number): ProviderEntry {
    let entry = this.entries.get(providerId);
    if (!entry) {
      entry = { spentUsd: 0, nextResetAtMs: nowMs + DAY_MS, lastUpdatedAtMs: nowMs };
      this.entries.set(providerId, entry);
    }
    this.resetIfDue(entry, nowMs);
    return entry;
  }

  private requireEntry(providerId: string, nowMs: number): ProviderEntry {
    const entry = this.entries.get(providerId);
    if (!entry) {
      throw new UnknownProviderError(providerId);
    }
    this.resetIfDue(entry, nowMs);
    return entry;
  }

  /** Rolls a provider's spend back to 0 once its daily window has elapsed, advancing nextResetAt by whole-day increments so a long-idle provider lands on the correct future boundary instead of drifting. */
  private resetIfDue(entry: ProviderEntry, nowMs: number): void {
    if (nowMs < entry.nextResetAtMs) {
      return;
    }
    const elapsedPeriods = Math.floor((nowMs - entry.nextResetAtMs) / DAY_MS) + 1;
    entry.nextResetAtMs += elapsedPeriods * DAY_MS;
    entry.spentUsd = 0;
  }
}
