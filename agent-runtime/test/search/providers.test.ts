import { describe, expect, it } from "vitest";

import { HttpFailure } from "../../src/net/keep-alive-http.js";
import { BraveSearchProvider } from "../../src/search/providers/brave.js";
import { DeepSeekSearchProvider } from "../../src/search/providers/deepseek.js";
import { GlmMcpSearchProvider, parseMcpBody } from "../../src/search/providers/glm-mcp.js";
import { TavilySearchProvider } from "../../src/search/providers/tavily.js";
import { SearchError, parseRetryAfter } from "../../src/search/types.js";
import { FakeHttp, json } from "./fake-http.js";

const REQUEST = { query: "今天上海天气", count: 5 };

describe("DeepSeek search provider", () => {
  it("posts the documented body and maps results, preferring the longer summary", async () => {
    const http = new FakeHttp(() =>
      json({
        results: [
          { title: "上海天气", url: "https://weather.example/sh", snippet: "short", summary: "a longer summary for a model", rerank_score: 2.4, date: "2026-10-25T01:00:00Z" },
          { title: "no url", url: "" },
        ],
      }),
    );

    const hits = await new DeepSeekSearchProvider(http).search({ ...REQUEST, recency: "day" }, 1000);

    expect(http.calls[0]).toMatchObject({ method: "POST", path: "/v1/tools/search" });
    expect(JSON.parse(http.calls[0]!.body!)).toEqual({ query: "今天上海天气", count: 5, need_content: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: "上海天气", url: "https://weather.example/sh", snippet: "a longer summary for a model", source: "deepseek", publishedAt: "2026-10-25T01:00:00Z" });
    expect(hits[0]!.score).toBeCloseTo(0.8); // rerank_score 0-3, normalized to 0-1
  });

  it("truncates a query over the API's 128-character limit by characters, not bytes", async () => {
    const http = new FakeHttp(() => json({ results: [] }));

    await new DeepSeekSearchProvider(http).search({ query: "天".repeat(300), count: 5 }, 1000);

    expect([...JSON.parse(http.calls[0]!.body!).query]).toHaveLength(128);
  });

  it.each([
    [401, "auth"],
    [402, "quota"],
    [429, "rate_limit"],
    [504, "timeout"],
    [500, "server"],
    [400, "bad_request"],
  ] as const)("classifies HTTP %i as %s", async (status, kind) => {
    const http = new FakeHttp(() => json({ error: "x" }, status, status === 429 ? { "retry-after": "7" } : {}));

    const error = await new DeepSeekSearchProvider(http).search(REQUEST, 1000).catch((e) => e);

    expect(error).toBeInstanceOf(SearchError);
    expect(error).toMatchObject({ provider: "deepseek", kind });
    if (status === 429) expect(error.retryAfterMs).toBe(7000);
  });

  it("maps a transport timeout and a dropped connection", async () => {
    const timeout = new FakeHttp(() => new HttpFailure("timeout", "slow"));
    const dropped = new FakeHttp(() => new HttpFailure("network", "reset"));

    await expect(new DeepSeekSearchProvider(timeout).search(REQUEST, 1000)).rejects.toMatchObject({ kind: "timeout" });
    await expect(new DeepSeekSearchProvider(dropped).search(REQUEST, 1000)).rejects.toMatchObject({ kind: "network" });
  });

  it("returns an empty list (not an error) when nothing matched", async () => {
    const http = new FakeHttp(() => json({ results: [] }));

    await expect(new DeepSeekSearchProvider(http).search(REQUEST, 1000)).resolves.toEqual([]);
  });
});

describe("Brave search provider", () => {
  it("sends the query, count and freshness, and maps web results", async () => {
    const http = new FakeHttp(() => json({ web: { results: [{ title: "T", url: "https://a.example/x", description: "D", page_age: "2026-10-24T00:00:00" }] } }));

    const hits = await new BraveSearchProvider(http).search({ query: "node lts", count: 3, recency: "week" }, 1000);

    const url = new URL(`https://x${http.calls[0]!.path}`);
    expect(url.pathname).toBe("/res/v1/web/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "node lts", count: "3", freshness: "pw" });
    expect(hits).toEqual([{ title: "T", url: "https://a.example/x", snippet: "D", source: "brave", publishedAt: "2026-10-24T00:00:00" }]);
  });

  it("reports a rate limit with its Retry-After", async () => {
    const http = new FakeHttp(() => json({}, 429, { "retry-after": "2" }));

    await expect(new BraveSearchProvider(http).search(REQUEST, 1000)).rejects.toMatchObject({ kind: "rate_limit", retryAfterMs: 2000 });
  });
});

describe("Tavily search provider", () => {
  it("uses basic depth by default and the news topic and time range when asked", async () => {
    const http = new FakeHttp(() => json({ results: [{ title: "T", url: "https://n.example", content: "C", score: 0.91, published_date: "2026-10-25" }] }));

    const hits = await new TavilySearchProvider(http).search({ query: "q", count: 4, topic: "news", recency: "day" }, 1000);

    expect(JSON.parse(http.calls[0]!.body!)).toEqual({ query: "q", search_depth: "basic", max_results: 4, topic: "news", time_range: "day" });
    expect(hits[0]).toMatchObject({ source: "tavily", score: 0.91, snippet: "C", publishedAt: "2026-10-25" });
  });

  it("spends the 2-credit advanced tier only when the plan asks for depth", async () => {
    const http = new FakeHttp(() => json({ results: [] }));

    await new TavilySearchProvider(http).search({ ...REQUEST, deep: true }, 1000);

    expect(JSON.parse(http.calls[0]!.body!).search_depth).toBe("advanced");
  });

  it("treats the plan-limit statuses as quota exhaustion", async () => {
    for (const status of [432, 433]) {
      const http = new FakeHttp(() => json({}, status));
      await expect(new TavilySearchProvider(http).search(REQUEST, 1000)).rejects.toMatchObject({ kind: "quota" });
    }
  });
});

describe("GLM MCP search provider", () => {
  const sse = (message: object): string => `id:1\nevent:message\ndata:${JSON.stringify(message)}\n\n`;
  // The tool double-encodes: its text is a JSON string whose content is the JSON array.
  const toolText = (items: object[]): string => JSON.stringify(JSON.stringify(items));

  function scripted(onCall?: (n: number) => object) {
    let searches = 0;
    const http = new FakeHttp((request) => {
      const body = JSON.parse(request.body!);
      if (body.method === "initialize") return { status: 200, headers: { "mcp-session-id": `sess-${http.calls.length}` }, body: sse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05" } }) };
      if (body.method === "notifications/initialized") return { status: 202, headers: {}, body: "" };
      searches += 1;
      const result = onCall
        ? onCall(searches)
        : { content: [{ type: "text", text: toolText([{ title: "中国气象局", link: "http://weather.cma.cn/web/weather/58367.html", content: "气温 17℃" }]) }] };
      return { status: 200, headers: {}, body: sse({ jsonrpc: "2.0", id: body.id, result }) };
    });
    return http;
  }

  it("opens a real MCP session before calling the tool, and sends its id", async () => {
    const http = scripted();

    const hits = await new GlmMcpSearchProvider(http).search({ ...REQUEST, recency: "day" }, 1000);

    const methods = http.calls.map((c) => JSON.parse(c.body!).method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(http.calls[0]!.headers?.["mcp-session-id"]).toBeUndefined();
    expect(http.calls[2]!.headers?.["mcp-session-id"]).toMatch(/^sess-/);
    expect(JSON.parse(http.calls[2]!.body!).params).toEqual({
      name: "web_search_prime",
      arguments: { search_query: "今天上海天气", content_size: "medium", search_recency_filter: "oneDay" },
    });
    expect(hits).toEqual([{ title: "中国气象局", url: "http://weather.cma.cn/web/weather/58367.html", snippet: "气温 17℃", source: "glm" }]);
  });

  it("reuses the session for later searches and shares one handshake between concurrent ones", async () => {
    const http = scripted();
    const provider = new GlmMcpSearchProvider(http);

    await Promise.all([provider.search(REQUEST, 1000), provider.search(REQUEST, 1000)]);
    await provider.search(REQUEST, 1000);

    expect(http.calls.map((c) => JSON.parse(c.body!).method).filter((m) => m === "initialize")).toHaveLength(1);
    expect(http.calls.filter((c) => JSON.parse(c.body!).method === "tools/call")).toHaveLength(3);
  });

  it("reports the tool's own 401 as an auth failure after retrying once on a fresh session", async () => {
    const http = scripted(() => ({ isError: true, content: [{ type: "text", text: "MCP error -401: Api key not found, please get your apikey" }] }));
    const provider = new GlmMcpSearchProvider(http);

    await expect(provider.search(REQUEST, 1000)).rejects.toMatchObject({ provider: "glm", kind: "auth" });

    expect(http.calls.filter((c) => JSON.parse(c.body!).method === "initialize")).toHaveLength(2);
  });

  it("recovers when the server has forgotten the session", async () => {
    let first = true;
    const http = scripted((n) => {
      if (n === 1 && first) {
        first = false;
        return { isError: true, content: [{ type: "text", text: "MCP error -401: Api key not found" }] };
      }
      return { content: [{ type: "text", text: toolText([{ title: "ok", link: "https://ok.example", content: "c" }]) }] };
    });

    const hits = await new GlmMcpSearchProvider(http).search(REQUEST, 1000);

    expect(hits[0]?.url).toBe("https://ok.example");
  });

  it("treats the content-safety filter as a property of the query, not as a sick provider", async () => {
    const http = scripted(() => ({ isError: true, content: [{ type: "text", text: 'MCP error -400: {"contentFilter":[{"level":1,"role":"search"}]}' }] }));

    await expect(new GlmMcpSearchProvider(http).search(REQUEST, 1000)).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("classifies exhausted balance as quota", async () => {
    const http = scripted(() => ({ isError: true, content: [{ type: "text", text: "余额不足或无可用资源包,请充值。 code 1113" }] }));

    await expect(new GlmMcpSearchProvider(http).search(REQUEST, 1000)).rejects.toMatchObject({ kind: "quota" });
  });

  it("classifies the weekly/monthly plan cap as quota even though it arrives as a 429", async () => {
    const text = 'MCP error -429: {"error":{"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-11-18 16:46:41 重置。"}}';
    const http = scripted(() => ({ isError: true, content: [{ type: "text", text }] }));

    await expect(new GlmMcpSearchProvider(http).search(REQUEST, 1000)).rejects.toMatchObject({ kind: "quota" });
  });

  it("limits results to the requested count", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, link: `https://x.example/${i}`, content: "c" }));
    const http = scripted(() => ({ content: [{ type: "text", text: toolText(items) }] }));

    expect(await new GlmMcpSearchProvider(http).search({ ...REQUEST, count: 3 }, 1000)).toHaveLength(3);
  });

  it("parses SSE-framed and plain JSON bodies", () => {
    expect(parseMcpBody('id:1\nevent:message\ndata:{"id":2,"result":{}}\n')).toEqual({ id: 2, result: {} });
    expect(parseMcpBody('{"id":3}')).toEqual({ id: 3 });
    expect(parseMcpBody("garbage")).toBeUndefined();
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates, and ignores junk", () => {
    expect(parseRetryAfter("12")).toBe(12000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
