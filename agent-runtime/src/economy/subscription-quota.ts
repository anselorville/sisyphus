/**
 * Subscription Quota: the coding-plan half of the swarm's food economy (see
 * ./api-budget.ts for the other half, and ./types.ts for the shared
 * FoodState vocabulary both are summarized through).
 *
 * HttpQuotaProbe is fully generic -- it works for any coding-plan provider
 * without provider-specific code -- because everything provider-specific
 * (the URL, the auth env var, and where in the response body the two
 * numbers we care about live) is pushed into HttpQuotaProbeConfig. Reading
 * those two fields out of an arbitrary response body uses a JSON-Pointer
 * (RFC 6901) style lookup, e.g. "/limits/five_hour/remaining_percent".
 *
 * Fail-safe posture (see the global constraint in Task 13's own prompt --
 * "stale quota data must automatically degrade to the most conservative
 * state, never optimistically assume the last-known-good value is still
 * true"): refresh() NEVER rejects. A network failure, a non-2xx response, a
 * response whose configured pointers don't resolve to usable values, or a
 * cache entry older than its TTL, all resolve to the same conservative
 * fallback snapshot -- remainingRatio 0, which foodState() maps to
 * "hibernating", the most conservative band FoodState has. A caller that
 * only reads the resolved value can never mistake degraded, made-up news
 * for a real, still-good reading; a caller that checks `degraded` can tell
 * the two apart explicitly.
 */

import { foodState, type FoodState } from "./types.js";

/** Matches fetch's own signature, mirroring the FetchLike seam in ../tools/web-tools.ts, so a real `fetch` or a test fake are interchangeable. Declared locally (rather than imported from ../tools/web-tools.ts) because the economy layer intentionally doesn't depend on the tools layer. */
export type FetchLike = typeof fetch;

export interface HttpQuotaProbeConfig {
  readonly providerId: string;
  readonly url: string;
  /** Name of the environment variable holding the bearer token sent as `Authorization: Bearer <token>`. If unset at refresh time, the request is simply sent without an Authorization header and whatever the server does with that (most likely a non-ok response) is handled the same as any other fetch failure. */
  readonly authEnv: string;
  /** JSON-Pointer (RFC 6901) path into the response body for the remaining-quota reading. */
  readonly remainingJsonPointer: string;
  /** JSON-Pointer (RFC 6901) path into the response body for the reset timestamp. */
  readonly resetAtJsonPointer: string;
  /** Free-text label for which billing window this probe tracks (e.g. "5h", "weekly"). Not fetched -- just echoed onto every snapshot. Default: "unknown". */
  readonly windowType?: string;
}

export interface HttpQuotaProbeOptions {
  readonly config: HttpQuotaProbeConfig;
  readonly fetchImpl?: FetchLike;
  /** How long a successful reading stays valid before the next refresh() re-fetches. Default 60_000ms. */
  readonly ttlMs?: number;
  readonly now?: () => Date;
}

export interface SubscriptionQuotaSnapshot {
  readonly providerId: string;
  readonly windowType: string;
  /** 0-1 fraction of quota remaining in the current billing window. */
  readonly remainingRatio: number;
  /** ISO-8601 timestamp of the next reset. */
  readonly resetAt: string;
  readonly foodState: FoodState;
  /** Whether ordinary workers may currently use this provider at all -- derived (never fetched): false whenever this snapshot is degraded, or the window is fully exhausted. */
  readonly ordinaryAccessAllowed: boolean;
  /** When this snapshot was produced (or, for a degraded snapshot, when the fallback was manufactured). */
  readonly fetchedAt: string;
  /** True when this snapshot is the conservative fallback (a stale cache with no successful re-fetch, a fetch failure, a non-ok response, or unusable pointer values) rather than a value just read from the provider. */
  readonly degraded: boolean;
}

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  readonly snapshot: SubscriptionQuotaSnapshot;
  readonly expiresAtMs: number;
}

export class HttpQuotaProbe {
  private readonly config: HttpQuotaProbeConfig;
  private readonly fetchImpl: FetchLike;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private cached: CacheEntry | undefined;

  constructor(options: HttpQuotaProbeOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Returns the cached reading if it is still within its TTL (no network
   * call). Otherwise fetches a fresh one. Never rejects: any failure along
   * the way (thrown fetch, non-ok status, unusable pointer values) resolves
   * to the conservative fallback snapshot instead of the stale cached value
   * or a thrown error.
   */
  async refresh(): Promise<SubscriptionQuotaSnapshot> {
    const nowMs = this.now().getTime();
    if (this.cached && nowMs < this.cached.expiresAtMs) {
      return this.cached.snapshot;
    }

    let snapshot: SubscriptionQuotaSnapshot;
    try {
      snapshot = await this.fetchSnapshot(nowMs);
    } catch {
      snapshot = this.degradedSnapshot(nowMs);
    }

    this.cached = { snapshot, expiresAtMs: nowMs + this.ttlMs };
    return snapshot;
  }

  private async fetchSnapshot(nowMs: number): Promise<SubscriptionQuotaSnapshot> {
    const token = process.env[this.config.authEnv];
    const response = await this.fetchImpl(this.config.url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!response.ok) {
      return this.degradedSnapshot(nowMs);
    }

    const body: unknown = await response.json();
    const remainingRaw = jsonPointerGet(body, this.config.remainingJsonPointer);
    const resetAtRaw = jsonPointerGet(body, this.config.resetAtJsonPointer);

    if (typeof remainingRaw !== "number" || !Number.isFinite(remainingRaw) || typeof resetAtRaw !== "string") {
      return this.degradedSnapshot(nowMs);
    }

    return this.buildSnapshot(normalizeRatio(remainingRaw), resetAtRaw, nowMs, false);
  }

  /** The conservative fallback: 0 remaining, "hibernating", ordinary access denied. Never derived from a possibly-stale prior reading -- always self-consistent and always the most conservative thing foodState() can report. */
  private degradedSnapshot(nowMs: number): SubscriptionQuotaSnapshot {
    return this.buildSnapshot(0, new Date(nowMs).toISOString(), nowMs, true);
  }

  private buildSnapshot(
    remainingRatio: number,
    resetAt: string,
    nowMs: number,
    degraded: boolean,
  ): SubscriptionQuotaSnapshot {
    return Object.freeze({
      providerId: this.config.providerId,
      windowType: this.config.windowType ?? "unknown",
      remainingRatio,
      resetAt,
      foodState: foodState(remainingRatio),
      ordinaryAccessAllowed: !degraded && remainingRatio > 0,
      fetchedAt: new Date(nowMs).toISOString(),
      degraded,
    });
  }
}

/** Normalizes a raw "remaining" reading into a 0-1 ratio: a value already <= 1 is treated as an already-normalized fraction (e.g. 0.62); a value > 1 is treated as a whole percentage (e.g. 62 -> 0.62). Clamped to [0, 1] either way. */
function normalizeRatio(raw: number): number {
  const ratio = raw > 1 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, ratio));
}

/** Minimal RFC 6901 JSON Pointer reader: "/a/b/c" navigates nested objects/arrays. Returns undefined (never throws) the moment the path can't be followed any further. */
function jsonPointerGet(root: unknown, pointer: string): unknown {
  if (pointer === "") {
    return root;
  }
  if (!pointer.startsWith("/")) {
    throw new RangeError(`JSON pointer must start with "/", got: "${pointer}"`);
  }

  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}
