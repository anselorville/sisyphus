/**
 * Tavily (https://docs.tavily.com/documentation/api-reference/endpoint/search).
 * Built for LLM consumption: relevance-scored results with extracted content,
 * a `news` topic and a `time_range`. The server answers in 0.1-0.4s; the rest
 * of the ~1.3s seen from here is network, plus a ~5.5s TLS handshake on a cold
 * connection (so it must be warmed). `advanced` depth costs 2 credits and is
 * only used when the plan asks for deeper recall.
 */

import { HttpFailure, type HttpPort } from "../../net/keep-alive-http.js";
import { SearchError, classifyStatus, parseRetryAfter, type SearchHit, type SearchProvider, type SearchRequest } from "../types.js";

export const TAVILY_BASE_URL = "https://api.tavily.com";

interface TavilyResponse {
  readonly results?: ReadonlyArray<{ title?: string; url?: string; content?: string; score?: number; published_date?: string | null }>;
}

export class TavilySearchProvider implements SearchProvider {
  readonly id = "tavily";
  readonly slowCold = true;

  constructor(private readonly http: HttpPort) {}

  async warm(): Promise<void> {
    await this.http.ping();
  }

  async search(request: SearchRequest, timeoutMs: number): Promise<SearchHit[]> {
    const body: Record<string, unknown> = {
      query: request.query,
      search_depth: request.deep ? "advanced" : "basic",
      max_results: Math.min(Math.max(request.count, 1), 20),
      topic: request.topic === "news" ? "news" : "general",
    };
    if (request.recency) body["time_range"] = request.recency;
    let response;
    try {
      response = await this.http.request({
        method: "POST",
        path: "/search",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof HttpFailure) throw new SearchError(this.id, error.kind, error.message);
      throw new SearchError(this.id, "network", error instanceof Error ? error.message : String(error));
    }
    if (response.status !== 200) {
      throw classifyStatus(this.id, response.status, response.body, parseRetryAfter(response.headers["retry-after"]));
    }
    let payload: TavilyResponse;
    try {
      payload = JSON.parse(response.body) as TavilyResponse;
    } catch {
      throw new SearchError(this.id, "server", "response is not JSON");
    }
    return (payload.results ?? [])
      .filter((r) => typeof r.url === "string" && r.url !== "")
      .map((r) => ({
        title: r.title ?? "",
        url: r.url as string,
        snippet: r.content ?? "",
        source: this.id,
        ...(typeof r.score === "number" ? { score: Math.min(Math.max(r.score, 0), 1) } : {}),
        ...(r.published_date ? { publishedAt: r.published_date } : {}),
      }));
  }

  close(): void {
    this.http.close();
  }
}
