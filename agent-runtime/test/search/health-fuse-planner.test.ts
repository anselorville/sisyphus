import { describe, expect, it } from "vitest";

import { canonicalUrl, fuse } from "../../src/search/fuse.js";
import { SearchHealth } from "../../src/search/health.js";
import { planByRules, searchPlanSpec } from "../../src/search/planner.js";
import { SearchError, type SearchHit } from "../../src/search/types.js";
import { parseResponse } from "../../src/decision/jev-client.js";

const err = (kind: ConstructorParameters<typeof SearchError>[1], retryAfterMs?: number) => new SearchError("p", kind, "x", retryAfterMs);

describe("SearchHealth", () => {
  it("keeps a provider available through a single transient failure, and backs off when it repeats", () => {
    let now = 0;
    const health = new SearchHealth({ now: () => now });

    health.recordFailure("p", err("timeout"));
    expect(health.isAvailable("p")).toBe(true);
    health.recordFailure("p", err("server"));
    expect(health.isAvailable("p")).toBe(false);
    now += 10_001;
    expect(health.isAvailable("p")).toBe(true);
    health.recordFailure("p", err("network")); // third in a row: 20s
    now += 15_000;
    expect(health.isAvailable("p")).toBe(false);
    now += 6_000;
    expect(health.isAvailable("p")).toBe(true);
  });

  it("a success clears the failure streak and the cool-down", () => {
    let now = 0;
    const health = new SearchHealth({ now: () => now });
    health.recordFailure("p", err("timeout"));
    health.recordFailure("p", err("timeout"));

    now += 10_001;
    health.recordSuccess("p", 300);
    health.recordFailure("p", err("timeout"));

    expect(health.isAvailable("p")).toBe(true);
    expect(health.snapshot(["p"])[0]).toMatchObject({ consecutiveFailures: 1 });
  });

  it.each([
    ["auth", 30 * 60_000],
    ["quota", 15 * 60_000],
  ] as const)("a %s failure benches the provider for a long time at once", (kind, ms) => {
    let now = 0;
    const health = new SearchHealth({ now: () => now });

    health.recordFailure("p", err(kind));

    expect(health.isAvailable("p")).toBe(false);
    now += ms - 1;
    expect(health.isAvailable("p")).toBe(false);
    now += 2;
    expect(health.isAvailable("p")).toBe(true);
  });

  it("honours Retry-After for a rate limit, capped", () => {
    let now = 0;
    const health = new SearchHealth({ now: () => now });

    health.recordFailure("p", err("rate_limit", 5_000));
    now += 5_001;
    expect(health.isAvailable("p")).toBe(true);

    health.recordFailure("p", err("rate_limit", 9 * 3_600_000));
    now += 10 * 60_000 + 1;
    expect(health.isAvailable("p")).toBe(true);
  });

  it("does not blame the provider for our own bad request", () => {
    const health = new SearchHealth();

    health.recordFailure("p", err("bad_request"));

    expect(health.isAvailable("p")).toBe(true);
    expect(health.snapshot(["p"])[0]!.failures).toBe(0);
  });

  it("tracks a smoothed latency", () => {
    const health = new SearchHealth();
    health.recordSuccess("p", 1000);
    health.recordSuccess("p", 200);

    expect(health.snapshot(["p"])[0]!.ewmaMs).toBeCloseTo(760);
  });
});

const hit = (url: string, source: string, snippet = "s", title = "t"): SearchHit => ({ title, url, snippet, source });

describe("fuse", () => {
  it("canonicalizes the same page across scheme, www, fragment, trailing slash and tracking params", () => {
    const base = canonicalUrl("https://example.com/a/b");
    for (const variant of ["http://www.example.com/a/b/", "https://example.com/a/b#top", "https://example.com/a/b?utm_source=x&fbclid=1", "HTTPS://EXAMPLE.com/a/b"]) {
      expect(canonicalUrl(variant)).toBe(base);
    }
    expect(canonicalUrl("https://example.com/a/b?id=2")).not.toBe(base);
  });

  it("ranks a page two independent indexes both return above one only a single index ranks first", () => {
    const fused = fuse(
      [
        { provider: "deepseek", hits: [hit("https://solo.example/1", "deepseek"), hit("https://both.example/2", "deepseek")] },
        { provider: "brave", hits: [hit("https://other.example/3", "brave"), hit("http://www.both.example/2/", "brave")] },
      ],
      5,
    );

    expect(fused[0]!.url).toBe("https://both.example/2");
    expect(fused[0]!.agreedBy).toEqual(["deepseek", "brave"]);
    expect(fused.map((f) => f.agreedBy.length)).toEqual([2, 1, 1]);
  });

  it("merges duplicates keeping the fullest description and a title", () => {
    const fused = fuse(
      [
        { provider: "a", hits: [hit("https://x.example/p", "a", "short", "")] },
        { provider: "b", hits: [hit("https://x.example/p", "b", "a much longer description", "Real title")] },
      ],
      5,
    );

    expect(fused).toHaveLength(1);
    expect(fused[0]).toMatchObject({ snippet: "a much longer description", title: "Real title" });
  });

  it("respects the limit and a provider weight", () => {
    const fused = fuse(
      [
        { provider: "weak", hits: [hit("https://w.example/1", "weak")], weight: 0.1 },
        { provider: "strong", hits: [hit("https://s.example/1", "strong")], weight: 2 },
      ],
      1,
    );

    expect(fused).toHaveLength(1);
    expect(fused[0]!.url).toBe("https://s.example/1");
  });
});

describe("planByRules", () => {
  it("answers a simple lookup from one source", () => {
    expect(planByRules("Node.js 22 LTS release date")).toMatchObject({ mode: "single", width: 1, topic: "general", deep: false });
  });

  it("treats 'today' questions as day-fresh and prefers Tavily's news-capable index second", () => {
    const plan = planByRules("今天上海天气怎么样");

    expect(plan.recency).toBe("day");
    expect(plan.tiers[0]).toEqual(["deepseek"]);
    expect(plan.tiers[1]).toEqual(["tavily"]);
  });

  it("marks news queries as the news topic", () => {
    expect(planByRules("最近有什么科技新闻")).toMatchObject({ topic: "news", recency: "week" });
  });

  it("fans out on a comparison or a long, multi-part question", () => {
    expect(planByRules("PostgreSQL 和 MySQL 的区别与优缺点对比")).toMatchObject({ mode: "fanout", width: 2 });
    expect(planByRules("a".repeat(45))).toMatchObject({ mode: "fanout" });
  });

  it("goes deep and wide for research-grade questions", () => {
    expect(planByRules("请深入全面研究一下固态电池的技术路线对比")).toMatchObject({ mode: "fanout", width: 3, deep: true });
  });

  it("keeps a precise operator query on a single source", () => {
    expect(planByRules('site:github.com "pipecat" websocket transport examples comparison')).toMatchObject({ mode: "single" });
  });

  it("puts GLM's Chinese index ahead of the English-leaning ones for hard Chinese questions", () => {
    expect(planByRules("为什么中文分词对检索效果影响这么大，原理是什么").tiers[1]).toEqual(["glm"]);
  });
});

describe("searchPlanSpec", () => {
  const rule = planByRules("什么是向量数据库");
  const respond = (difficulty: Record<string, number>, freshness: Record<string, number>) =>
    parseResponse(
      JSON.stringify({
        answers: {
          difficulty: { type: "choice", choice: Object.entries(difficulty).sort((a, b) => b[1] - a[1])[0]![0], confidence: 1, probabilities: difficulty },
          freshness: { type: "choice", choice: Object.entries(freshness).sort((a, b) => b[1] - a[1])[0]![0], confidence: 1, probabilities: freshness },
        },
      }),
      1,
    );

  it("widens a plan Jev judges to need cross-checking, and asks for fresh results when answers go stale by the hour", () => {
    const out = searchPlanSpec.interpret(respond({ lookup: 0.1, multi_facet: 0.1, research: 0.8 }, { stable: 0.05, weeks: 0.05, hours: 0.9 }), { query: "q", rule });

    expect(out?.value).toMatchObject({ mode: "fanout", width: 3, deep: true, recency: "day" });
  });

  it("narrows to one source for a plain lookup and drops a spurious recency", () => {
    const ruleWithRecency = planByRules("最近的天气");
    const out = searchPlanSpec.interpret(respond({ lookup: 0.95, multi_facet: 0.03, research: 0.02 }, { stable: 0.9, weeks: 0.05, hours: 0.05 }), { query: "q", rule: ruleWithRecency });

    expect(out?.value.mode).toBe("single");
    expect(out?.value.recency).toBeUndefined();
  });

  it("keeps the rule's freshness when Jev is not sure about it", () => {
    const out = searchPlanSpec.interpret(respond({ lookup: 0.9, multi_facet: 0.05, research: 0.05 }, { stable: 0.4, weeks: 0.35, hours: 0.25 }), { query: "q", rule: planByRules("今天天气") });

    expect(out?.value.recency).toBe("day");
  });

  it("declines when it cannot tell how hard the question is", () => {
    expect(searchPlanSpec.interpret(respond({ lookup: 0.4, multi_facet: 0.35, research: 0.25 }, { stable: 1, weeks: 0, hours: 0 }), { query: "q", rule })).toBeUndefined();
  });
});
