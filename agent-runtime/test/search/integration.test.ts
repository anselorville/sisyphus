import { describe, expect, it } from "vitest";

import { createSearchProviders } from "../../src/search/factory.js";
import { SearchRouter } from "../../src/search/router.js";
import { WebTools, type SearchPort } from "../../src/tools/web-tools.js";
import { createWebToolDefinitions } from "../../src/tools/web-tool-definitions.js";
import type { SearchHit, SearchProvider } from "../../src/search/types.js";

const gateway = { execute: <T>(_e: unknown, op: () => Promise<T>) => op() };

class Stub implements SearchProvider {
  constructor(readonly id: string, private readonly urls: string[]) {}
  async warm(): Promise<void> {}
  async search(): Promise<SearchHit[]> {
    return this.urls.map((url, i) => ({ title: `${this.id} ${i}`, url, snippet: "s", source: this.id, publishedAt: "2026-10-25T08:00:00Z" }));
  }
  close(): void {}
}

describe("createSearchProviders", () => {
  it("builds exactly the providers that have a key, in the chain's usual order", () => {
    const ids = createSearchProviders({ DEEPSEEK_API_KEY: "a", BRAVE_SEARCH_API_KEY: "b", TAVILY_API_KEY: "c", GLM_API_KEY: "d" }).map((p) => p.id);

    expect(ids).toEqual(["deepseek", "brave", "tavily", "glm"]);
  });

  it("skips providers without a key, and treats a blank key as missing", () => {
    const ids = createSearchProviders({ DEEPSEEK_API_KEY: "a", BRAVE_SEARCH_API_KEY: "   ", TAVILY_API_KEY: "" }).map((p) => p.id);

    expect(ids).toEqual(["deepseek"]);
  });

  it("honours SEARCH_PROVIDERS as an allowlist", () => {
    const providers = createSearchProviders({ DEEPSEEK_API_KEY: "a", BRAVE_SEARCH_API_KEY: "b", TAVILY_API_KEY: "c", SEARCH_PROVIDERS: " Brave , tavily" });

    expect(providers.map((p) => p.id)).toEqual(["brave", "tavily"]);
    providers.forEach((p) => p.close());
  });

  it("yields no providers when nothing is configured", () => {
    expect(createSearchProviders({})).toEqual([]);
  });
});

describe("web_search through the router", () => {
  it("returns results with the providers that found each page", async () => {
    const router = new SearchRouter({
      providers: [new Stub("deepseek", ["https://a.example/x", "https://b.example"]), new Stub("tavily", ["https://www.a.example/x/"])],
      fanoutGraceMs: 20,
    });
    const tools = new WebTools({ gateway, search: router as SearchPort });

    const results = await tools.web_search("PostgreSQL 和 MySQL 的区别与优缺点对比", { count: 3 });

    expect(results[0]).toMatchObject({ url: "https://a.example/x", sources: ["deepseek", "tavily"] });
  });

  it("tells the model which pages several independent indexes agreed on, and when they were published", async () => {
    const router = new SearchRouter({ providers: [new Stub("deepseek", ["https://a.example/x"]), new Stub("tavily", ["https://a.example/x"])], fanoutGraceMs: 20 });
    const [, fetchTool] = [null, null];
    void fetchTool;
    const definitions = createWebToolDefinitions(new WebTools({ gateway, search: router as SearchPort }));
    const search = definitions.find((d) => d.name === "web_search")!;

    const out = await search.execute("call", { query: "PostgreSQL 和 MySQL 的区别与优缺点对比" } as never, undefined as never, undefined as never, undefined as never);

    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("(found by deepseek + tavily)");
    expect(text).toContain("[2026-10-25]");
  });

  it("surfaces a total failure as an error the model can report, not as an empty answer", async () => {
    const failing: SearchProvider = {
      id: "deepseek",
      warm: async () => {},
      search: async () => {
        throw new Error("down");
      },
      close: () => {},
    };
    const tools = new WebTools({ gateway, search: new SearchRouter({ providers: [failing] }) as SearchPort });

    await expect(tools.web_search("anything", {})).rejects.toThrow(/all search providers failed/);
  });
});
