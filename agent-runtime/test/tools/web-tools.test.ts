import { describe, expect, it } from "vitest";

import { CapabilityGateway } from "../../src/tools/capability-gateway.js";
import { DiplomacyOfficer } from "../../src/tools/diplomacy-officer.js";
import {
  BraveSearchConfigError,
  InvalidUrlSchemeError,
  TooManyRedirectsError,
  WebFetchTimeoutError,
  WebTools,
} from "../../src/tools/web-tools.js";
import type { FetchLike } from "../../src/tools/web-tools.js";

function makeGateway(): CapabilityGateway {
  // Real DiplomacyOfficer + real CapabilityGateway: web_search/web_fetch are
  // plain reads, so this proves they sail through the actual rules (always
  // ALLOW) rather than needing a fake gateway that assumes the answer.
  return new CapabilityGateway({ officer: new DiplomacyOfficer() });
}

describe("WebTools.web_search", () => {
  it("maps a Brave Search response into WebSearchResult[]", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [{ title: "Result A", url: "https://a.example/", description: "About A" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as FetchLike;

    const tools = new WebTools({ gateway: makeGateway(), fetchImpl, brave: { apiKey: "test-key" } });
    const results = await tools.web_search("swarm agents");

    expect(results).toEqual([{ title: "Result A", url: "https://a.example/", snippet: "About A" }]);
  });

  it("throws BraveSearchConfigError when no API key is configured", async () => {
    const originalEnv = process.env["BRAVE_SEARCH_API_KEY"];
    delete process.env["BRAVE_SEARCH_API_KEY"];
    try {
      const tools = new WebTools({ gateway: makeGateway(), fetchImpl: (async () => new Response("{}")) as FetchLike });
      await expect(tools.web_search("anything")).rejects.toThrow(BraveSearchConfigError);
    } finally {
      if (originalEnv !== undefined) {
        process.env["BRAVE_SEARCH_API_KEY"] = originalEnv;
      }
    }
  });

  it("rejects an empty query before ever calling fetch", async () => {
    let called = false;
    const fetchImpl: FetchLike = (async () => {
      called = true;
      return new Response("{}");
    }) as FetchLike;
    const tools = new WebTools({ gateway: makeGateway(), fetchImpl, brave: { apiKey: "test-key" } });

    await expect(tools.web_search("   ")).rejects.toThrow(RangeError);
    expect(called).toBe(false);
  });

  it("throws when the Brave endpoint responds with a non-ok status", async () => {
    const fetchImpl: FetchLike = (async () => new Response("nope", { status: 500 })) as FetchLike;
    const tools = new WebTools({ gateway: makeGateway(), fetchImpl, brave: { apiKey: "test-key" } });
    await expect(tools.web_search("anything")).rejects.toThrow(/500/);
  });
});

describe("WebTools.web_fetch", () => {
  it("rejects non-http/https schemes before any network call", async () => {
    let called = false;
    const fetchImpl: FetchLike = (async () => {
      called = true;
      return new Response("");
    }) as FetchLike;
    const tools = new WebTools({ gateway: makeGateway(), fetchImpl });

    await expect(tools.web_fetch("file:///etc/passwd")).rejects.toThrow(InvalidUrlSchemeError);
    expect(called).toBe(false);
  });

  it("follows redirects up to the configured cap, then reports the final response", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async (url) => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 302, headers: { location: "https://example.test/next" } });
      }
      return new Response("landed", { status: 200, headers: { "content-type": "text/plain" } });
    }) as FetchLike;
    const tools = new WebTools({ gateway: makeGateway(), fetchImpl, webFetch: { maxRedirects: 5 } });

    const result = await tools.web_fetch("https://example.test/start");
    expect(result.url).toBe("https://example.test/next");
    expect(result.body).toBe("landed");
    expect(result.truncated).toBe(false);
  });

  it("throws TooManyRedirectsError once the redirect cap is exceeded", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(null, { status: 302, headers: { location: "https://example.test/loop" } })) as FetchLike;
    const tools = new WebTools({ gateway: makeGateway(), fetchImpl, webFetch: { maxRedirects: 2 } });

    await expect(tools.web_fetch("https://example.test/start")).rejects.toThrow(TooManyRedirectsError);
  });

  it("truncates a body larger than maxBytes and reports truncated: true", async () => {
    const big = "x".repeat(1000);
    const fetchImpl: FetchLike = (async () =>
      new Response(big, { status: 200, headers: { "content-type": "text/plain" } })) as FetchLike;
    const tools = new WebTools({ gateway: makeGateway(), fetchImpl, webFetch: { maxBytes: 100 } });

    const result = await tools.web_fetch("https://example.test/big");
    expect(result.truncated).toBe(true);
    expect(result.body.length).toBeLessThanOrEqual(100);
  });

  it("throws WebFetchTimeoutError when the request never settles within timeoutMs", async () => {
    const fetchImpl: FetchLike = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as FetchLike;
    const tools = new WebTools({ gateway: makeGateway(), fetchImpl, webFetch: { timeoutMs: 10 } });

    await expect(tools.web_fetch("https://example.test/slow")).rejects.toThrow(WebFetchTimeoutError);
  });
});
