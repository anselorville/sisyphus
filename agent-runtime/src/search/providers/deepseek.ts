/**
 * DeepSeek's search API (https://api-docs.deepseek.com/zh-cn/guides/search/):
 * `POST /v1/tools/search`, billed per successful request (5 CNY / 1000), not per
 * result, with a 100 QPS account limit. Measured at ~0.3s from this deployment
 * with no connection warm-up needed, so it leads the chain. It shares the LLM's
 * API key.
 */

import { HttpFailure, type HttpPort } from "../../net/keep-alive-http.js";
import { SearchError, classifyStatus, parseRetryAfter, type SearchHit, type SearchProvider, type SearchRequest } from "../types.js";

export const DEEPSEEK_SEARCH_BASE_URL = "https://api.deepseek.com";
/** The API rejects queries over 128 Unicode characters. */
const MAX_QUERY_CHARS = 128;

interface DeepSeekResult {
  readonly title?: string;
  readonly url?: string;
  readonly snippet?: string;
  readonly summary?: string;
  readonly rerank_score?: number;
  readonly date?: string | null;
}

export class DeepSeekSearchProvider implements SearchProvider {
  readonly id = "deepseek";

  constructor(private readonly http: HttpPort) {}

  async warm(): Promise<void> {
    await this.http.ping();
  }

  async search(request: SearchRequest, timeoutMs: number): Promise<SearchHit[]> {
    const query = [...request.query].slice(0, MAX_QUERY_CHARS).join("");
    let response;
    try {
      response = await this.http.request({
        method: "POST",
        path: "/v1/tools/search",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, count: Math.min(Math.max(request.count, 1), 50), need_content: false }),
        timeoutMs,
      });
    } catch (error) {
      throw this.transportError(error);
    }
    if (response.status !== 200) {
      throw classifyStatus(this.id, response.status, response.body, parseRetryAfter(response.headers["retry-after"]));
    }
    let payload: { results?: DeepSeekResult[] };
    try {
      payload = JSON.parse(response.body) as { results?: DeepSeekResult[] };
    } catch {
      throw new SearchError(this.id, "server", "response is not JSON");
    }
    return (payload.results ?? [])
      .filter((r) => typeof r.url === "string" && r.url !== "")
      .map((r) => ({
        title: r.title ?? "",
        url: r.url as string,
        // `snippet` is the short display text; `summary` is the longer text meant for a model.
        snippet: r.summary || r.snippet || "",
        source: this.id,
        ...(typeof r.rerank_score === "number" ? { score: Math.min(Math.max(r.rerank_score / 3, 0), 1) } : {}),
        ...(r.date ? { publishedAt: r.date } : {}),
      }));
  }

  close(): void {
    this.http.close();
  }

  private transportError(error: unknown): SearchError {
    if (error instanceof HttpFailure) return new SearchError(this.id, error.kind, error.message);
    return new SearchError(this.id, "network", error instanceof Error ? error.message : String(error));
  }
}
