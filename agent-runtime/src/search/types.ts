/**
 * Shared vocabulary of the search layer: a provider turns a request into
 * normalized hits or fails with a classified SearchError; the router
 * (./router.ts) decides which providers to ask and how to combine them.
 */

export type Recency = "day" | "week" | "month" | "year";
export type SearchTopic = "general" | "news";

export interface SearchRequest {
  readonly query: string;
  readonly count: number;
  /** Only results from this period, when the provider can express it. */
  readonly recency?: Recency;
  /** `news` asks providers with a news mode to use it. */
  readonly topic?: SearchTopic;
  /** Spend more for better recall (a provider's "advanced" tier), where one exists. */
  readonly deep?: boolean;
}

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** The provider that returned it. */
  readonly source: string;
  /** The provider's own relevance score, normalized to 0-1 when it has one. Comparable only within a provider. */
  readonly score?: number;
  readonly publishedAt?: string;
}

/**
 * How a provider failed, because each kind calls for a different response:
 *  - auth / quota: nothing will change soon -> long cool-down, try the next provider
 *  - rate_limit: it will work again after `retryAfterMs`
 *  - timeout / network / server: transient -> try the next provider now, back off if it repeats
 *  - bad_request: our request is wrong for this provider; retrying it is pointless
 *  - empty: the provider is fine, it just found nothing
 */
export type SearchErrorKind = "auth" | "quota" | "rate_limit" | "timeout" | "network" | "server" | "bad_request" | "empty";

export class SearchError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: SearchErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = "SearchError";
  }
}

export interface SearchProvider {
  readonly id: string;
  /**
   * True when a brand-new connection to this provider is expensive (a ~5.5s TLS
   * handshake from this deployment). The router keeps such a provider behind the
   * others until it has finished warming up; a provider that handshakes in
   * milliseconds needs no such care.
   */
  readonly slowCold?: boolean;
  /** Opens connections / sessions ahead of the first query. Never throws. */
  warm(): Promise<void>;
  search(request: SearchRequest, timeoutMs: number): Promise<SearchHit[]>;
  close(): void;
}

/** Maps an HTTP status the same way for every provider that has no more specific knowledge. */
export function classifyStatus(provider: string, status: number, body: string, retryAfterMs?: number): SearchError {
  const detail = `HTTP ${status}${body ? `: ${body.slice(0, 160).replace(/\s+/g, " ")}` : ""}`;
  if (status === 401 || status === 403) return new SearchError(provider, "auth", detail);
  if (status === 402 || status === 432 || status === 433) return new SearchError(provider, "quota", detail);
  if (status === 429) return new SearchError(provider, "rate_limit", detail, retryAfterMs);
  if (status === 408 || status === 504) return new SearchError(provider, "timeout", detail);
  if (status >= 500) return new SearchError(provider, "server", detail);
  return new SearchError(provider, "bad_request", detail);
}

/** `Retry-After` is seconds (or an HTTP date); returns milliseconds, or undefined when absent or unreadable. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
