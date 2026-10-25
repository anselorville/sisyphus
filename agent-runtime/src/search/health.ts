/**
 * Liveness of each search provider, so the router stops sending traffic to one
 * that cannot answer and comes back to it when it can.
 *
 * The cool-down depends on WHY a provider failed, because that predicts when
 * it will work again: a bad key or an exhausted balance will not fix itself in
 * seconds (but a balance can be topped up, so it is re-checked eventually); a
 * rate limit names its own wait; a timeout or 5xx is usually transient and only
 * earns a penalty if it repeats.
 */

import type { SearchError } from "./types.js";

export interface HealthOptions {
  readonly now?: () => number;
}

export interface ProviderHealthSnapshot {
  readonly id: string;
  readonly available: boolean;
  readonly cooldownRemainingMs: number;
  readonly consecutiveFailures: number;
  readonly calls: number;
  readonly failures: number;
  readonly ewmaMs: number | undefined;
  readonly lastError: string | undefined;
}

interface Record_ {
  calls: number;
  failures: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  ewmaMs: number | undefined;
  lastError: string | undefined;
}

const AUTH_COOLDOWN_MS = 30 * 60_000;
const QUOTA_COOLDOWN_MS = 15 * 60_000;
const RATE_LIMIT_DEFAULT_MS = 30_000;
const RATE_LIMIT_MAX_MS = 10 * 60_000;
const TRANSIENT_BASE_MS = 10_000;
const TRANSIENT_MAX_MS = 5 * 60_000;
const EWMA_WEIGHT = 0.3;

export class SearchHealth {
  private readonly now: () => number;
  private readonly records = new Map<string, Record_>();

  constructor(options: HealthOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
  }

  isAvailable(id: string): boolean {
    return this.now() >= (this.records.get(id)?.cooldownUntil ?? 0);
  }

  recordSuccess(id: string, ms: number): void {
    const r = this.record(id);
    r.calls += 1;
    r.consecutiveFailures = 0;
    r.cooldownUntil = 0;
    r.ewmaMs = r.ewmaMs === undefined ? ms : r.ewmaMs * (1 - EWMA_WEIGHT) + ms * EWMA_WEIGHT;
  }

  recordFailure(id: string, error: SearchError): void {
    // Our own request being wrong says nothing about the provider's health.
    if (error.kind === "bad_request") return;
    const r = this.record(id);
    r.calls += 1;
    r.failures += 1;
    r.consecutiveFailures += 1;
    r.lastError = `${error.kind}: ${error.message}`;
    const cooldown = this.cooldownFor(error, r.consecutiveFailures);
    if (cooldown > 0) r.cooldownUntil = this.now() + cooldown;
  }

  /** Providers that can be tried now, preserving the given order. */
  available(ids: readonly string[]): string[] {
    return ids.filter((id) => this.isAvailable(id));
  }

  snapshot(ids: readonly string[]): ProviderHealthSnapshot[] {
    const now = this.now();
    return ids.map((id) => {
      const r = this.records.get(id);
      return {
        id,
        available: this.isAvailable(id),
        cooldownRemainingMs: Math.max(0, (r?.cooldownUntil ?? 0) - now),
        consecutiveFailures: r?.consecutiveFailures ?? 0,
        calls: r?.calls ?? 0,
        failures: r?.failures ?? 0,
        ewmaMs: r?.ewmaMs,
        lastError: r?.lastError,
      };
    });
  }

  private record(id: string): Record_ {
    let r = this.records.get(id);
    if (!r) {
      r = { calls: 0, failures: 0, consecutiveFailures: 0, cooldownUntil: 0, ewmaMs: undefined, lastError: undefined };
      this.records.set(id, r);
    }
    return r;
  }

  private cooldownFor(error: SearchError, consecutive: number): number {
    switch (error.kind) {
      case "auth":
        return AUTH_COOLDOWN_MS;
      case "quota":
        return QUOTA_COOLDOWN_MS;
      case "rate_limit":
        return Math.min(error.retryAfterMs ?? RATE_LIMIT_DEFAULT_MS, RATE_LIMIT_MAX_MS);
      case "timeout":
      case "network":
      case "server":
        // A single blip is just a fallback; repeated failures back off exponentially.
        return consecutive < 2 ? 0 : Math.min(TRANSIENT_BASE_MS * 2 ** (consecutive - 2), TRANSIENT_MAX_MS);
      default:
        return 0;
    }
  }
}
