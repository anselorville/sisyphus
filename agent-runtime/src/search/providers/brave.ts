/**
 * Brave Search (https://api.search.brave.com/res/v1/web/search). An independent
 * index, which is why it is valuable for cross-checking DeepSeek. From this
 * deployment a warm connection answers in ~0.9s; a cold one adds a ~5.5s TLS
 * handshake, so the provider must be warmed.
 */

import { HttpFailure, type HttpPort } from "../../net/keep-alive-http.js";
import { SearchError, classifyStatus, parseRetryAfter, type Recency, type SearchHit, type SearchProvider, type SearchRequest } from "../types.js";

export const BRAVE_BASE_URL = "https://api.search.brave.com";

const FRESHNESS: Record<Recency, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

interface BraveResponse {
  readonly web?: { readonly results?: ReadonlyArray<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }> };
  readonly news?: { readonly results?: ReadonlyArray<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }> };
}

export class BraveSearchProvider implements SearchProvider {
  readonly id = "brave";
  readonly slowCold = true;

  constructor(private readonly http: HttpPort) {}

  async warm(): Promise<void> {
    await this.http.ping();
  }

  async search(request: SearchRequest, timeoutMs: number): Promise<SearchHit[]> {
    const params = new URLSearchParams({ q: request.query, count: String(Math.min(Math.max(request.count, 1), 20)) });
    if (request.recency) params.set("freshness", FRESHNESS[request.recency]);
    let response;
    try {
      response = await this.http.request({ method: "GET", path: `/res/v1/web/search?${params}`, headers: { accept: "application/json" }, timeoutMs });
    } catch (error) {
      if (error instanceof HttpFailure) throw new SearchError(this.id, error.kind, error.message);
      throw new SearchError(this.id, "network", error instanceof Error ? error.message : String(error));
    }
    if (response.status !== 200) {
      throw classifyStatus(this.id, response.status, response.body, parseRetryAfter(response.headers["retry-after"]));
    }
    let payload: BraveResponse;
    try {
      payload = JSON.parse(response.body) as BraveResponse;
    } catch {
      throw new SearchError(this.id, "server", "response is not JSON");
    }
    return (payload.web?.results ?? [])
      .filter((r) => typeof r.url === "string" && r.url !== "")
      .map((r) => ({
        title: r.title ?? "",
        url: r.url as string,
        snippet: r.description ?? "",
        source: this.id,
        ...(r.page_age ? { publishedAt: r.page_age } : {}),
      }));
  }

  close(): void {
    this.http.close();
  }
}
