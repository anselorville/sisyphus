/**
 * Zhipu GLM's web search, reached through its MCP server
 * (`web_search_prime` over streamable HTTP). The REST endpoint
 * (`/api/paas/v4/web_search`) answers 429 / code 1113 "no balance or resource
 * pack" on this account, so the MCP route is the one that works.
 *
 * MCP is stateful: a call is only accepted inside a session, i.e. after
 * `initialize` (whose response carries `Mcp-Session-Id`) and
 * `notifications/initialized`. Without the session, `initialize` succeeds but
 * every `tools/call` fails with "Api key not found" -- a misleading error that
 * cost an hour to understand. Responses come back SSE-framed
 * (`data: {...}`), and the tool's text is a JSON array encoded as a string.
 *
 * Slower than the others (~2.2s), so it sits at the end of the chain, but it
 * is the best Chinese-language second opinion and an independent index.
 */

import { HttpFailure, type HttpPort, type HttpResponse } from "../../net/keep-alive-http.js";
import { SearchError, classifyStatus, type Recency, type SearchHit, type SearchProvider, type SearchRequest } from "../types.js";

export const GLM_BASE_URL = "https://open.bigmodel.cn";
const MCP_PATH = "/api/mcp/web_search_prime/mcp";
const TOOL_NAME = "web_search_prime";
const RECENCY: Record<Recency, string> = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" };

interface McpEnvelope {
  readonly id?: number;
  readonly result?: { readonly isError?: boolean; readonly content?: ReadonlyArray<{ type?: string; text?: string }> };
  readonly error?: { readonly code?: number; readonly message?: string };
}

interface GlmItem {
  readonly title?: string;
  readonly link?: string;
  readonly content?: string;
  readonly publish_date?: string;
}

/** Pulls the JSON-RPC message out of an SSE-framed (or plain JSON) body. */
export function parseMcpBody(body: string): McpEnvelope | undefined {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as McpEnvelope;
    } catch {
      return undefined;
    }
  }
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        return JSON.parse(line.slice(5).trim()) as McpEnvelope;
      } catch {
        // keep looking: a later frame may be the real message
      }
    }
  }
  return undefined;
}

export class GlmMcpSearchProvider implements SearchProvider {
  readonly id = "glm";
  private sessionId: string | undefined;
  private opening: Promise<string> | undefined;
  private nextId = 1;

  constructor(private readonly http: HttpPort) {}

  async warm(): Promise<void> {
    await this.ensureSession().catch(() => undefined);
  }

  async search(request: SearchRequest, timeoutMs: number): Promise<SearchHit[]> {
    try {
      return await this.callOnce(request, timeoutMs);
    } catch (error) {
      // A session the server forgot looks like an auth or protocol error; one fresh session is the fix.
      if (error instanceof SearchError && (error.kind === "auth" || error.kind === "bad_request") && this.sessionId !== undefined) {
        this.sessionId = undefined;
        return this.callOnce(request, timeoutMs);
      }
      throw error;
    }
  }

  close(): void {
    this.http.close();
  }

  private async callOnce(request: SearchRequest, timeoutMs: number): Promise<SearchHit[]> {
    const sessionId = await this.ensureSession(timeoutMs);
    const args: Record<string, string> = { search_query: [...request.query].slice(0, 100).join(""), content_size: "medium" };
    if (request.recency) args["search_recency_filter"] = RECENCY[request.recency];
    const response = await this.rpc(
      { jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name: TOOL_NAME, arguments: args } },
      timeoutMs,
      sessionId,
    );
    if (response.status !== 200) throw classifyStatus(this.id, response.status, response.body);
    const message = parseMcpBody(response.body);
    if (!message) throw new SearchError(this.id, "server", "unreadable MCP response");
    if (message.error) throw this.classifyMcpError(message.error.message ?? "MCP error", message.error.code);
    const text = message.result?.content?.[0]?.text ?? "";
    if (message.result?.isError) throw this.classifyMcpError(text);
    return this.parseItems(text).slice(0, request.count);
  }

  private parseItems(text: string): SearchHit[] {
    let value: unknown;
    try {
      value = JSON.parse(text);
      // The tool double-encodes: the text is a JSON string whose content is the JSON array.
      if (typeof value === "string") value = JSON.parse(value);
    } catch {
      throw new SearchError(this.id, "server", `result is not JSON: ${text.slice(0, 80)}`);
    }
    if (!Array.isArray(value)) return [];
    return (value as GlmItem[])
      .filter((item) => typeof item.link === "string" && item.link !== "")
      .map((item) => ({
        title: item.title ?? "",
        url: item.link as string,
        snippet: item.content ?? "",
        source: this.id,
        ...(item.publish_date ? { publishedAt: item.publish_date } : {}),
      }));
  }

  private classifyMcpError(message: string, code?: number): SearchError {
    // The service's content-safety filter rejects some queries outright ("MCP error -400 ... contentFilter").
    // That says nothing about the provider's health, so it must not bench it.
    if (/-?400\b|contentFilter|敏感|违规/i.test(message) || code === 400) return new SearchError(this.id, "bad_request", message);
    if (/-?401|api key|unauthor/i.test(message) || code === 401) return new SearchError(this.id, "auth", message);
    if (/1113|余额|资源包|quota|balance/i.test(message)) return new SearchError(this.id, "quota", message);
    if (/429|rate|频率|限流/i.test(message)) return new SearchError(this.id, "rate_limit", message);
    return new SearchError(this.id, "server", message);
  }

  private async rpc(payload: object, timeoutMs: number, sessionId?: string): Promise<HttpResponse> {
    try {
      return await this.http.request({
        method: "POST",
        path: MCP_PATH,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
        body: JSON.stringify(payload),
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof HttpFailure) throw new SearchError(this.id, error.kind, error.message);
      throw new SearchError(this.id, "network", error instanceof Error ? error.message : String(error));
    }
  }

  private ensureSession(timeoutMs = 10_000): Promise<string> {
    if (this.sessionId) return Promise.resolve(this.sessionId);
    // Concurrent searches share one handshake instead of opening a session each.
    this.opening ??= this.openSession(timeoutMs).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async openSession(timeoutMs: number): Promise<string> {
    const init = await this.rpc(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "marcus", version: "1.0" } },
      },
      timeoutMs,
    );
    if (init.status !== 200) throw classifyStatus(this.id, init.status, init.body);
    const sessionId = init.headers["mcp-session-id"];
    if (!sessionId) throw new SearchError(this.id, "server", "initialize returned no Mcp-Session-Id");
    await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs, sessionId);
    this.sessionId = sessionId;
    return sessionId;
  }
}
