import { describe, expect, it, vi } from "vitest";

import { SearchHealth } from "../../src/search/health.js";
import { planByRules, type SearchPlan } from "../../src/search/planner.js";
import { SearchRouter, SearchUnavailableError, type SearchTrace } from "../../src/search/router.js";
import { SearchError, type SearchHit, type SearchProvider, type SearchRequest } from "../../src/search/types.js";

type Behavior = { hits?: string[]; error?: SearchError; delayMs?: number };

/** A provider whose answer, failure and speed are scripted. */
class FakeProvider implements SearchProvider {
  readonly requests: SearchRequest[] = [];
  warmed = 0;
  closed = false;
  constructor(
    readonly id: string,
    public behavior: Behavior = { hits: [`https://${id}.example/1`, `https://${id}.example/2`] },
  ) {}
  async warm(): Promise<void> {
    this.warmed += 1;
  }
  async search(request: SearchRequest): Promise<SearchHit[]> {
    this.requests.push(request);
    if (this.behavior.delayMs) await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    if (this.behavior.error) throw this.behavior.error;
    return (this.behavior.hits ?? []).map((url, i) => ({ title: `${this.id} ${i}`, url, snippet: `from ${this.id}`, source: this.id }));
  }
  close(): void {
    this.closed = true;
  }
}

const fail = (provider: string, kind: ConstructorParameters<typeof SearchError>[1], retryAfterMs?: number) => new SearchError(provider, kind, "boom", retryAfterMs);

function router(providers: FakeProvider[], extra: Partial<ConstructorParameters<typeof SearchRouter>[0]> = {}) {
  const traces: SearchTrace[] = [];
  return { traces, router: new SearchRouter({ providers, onSearch: (t) => traces.push(t), fanoutGraceMs: 30, ...extra }) };
}

const SIMPLE = "Node.js 22 LTS release date";

describe("SearchRouter: the fallback chain", () => {
  it("asks only the preferred provider for a simple question", async () => {
    const [deepseek, brave, tavily] = [new FakeProvider("deepseek"), new FakeProvider("brave"), new FakeProvider("tavily")];
    const { router: r, traces } = router([deepseek, brave, tavily]);

    const { hits } = await r.search(SIMPLE, { count: 3 });

    expect(hits.map((h) => h.source)).toEqual(["deepseek", "deepseek"]);
    expect([brave.requests.length, tavily.requests.length]).toEqual([0, 0]);
    expect(traces[0]).toMatchObject({ plan: "single/1/-/general", contributors: ["deepseek"] });
  });

  it("falls through to the next provider when the first fails, in the plan's order", async () => {
    const deepseek = new FakeProvider("deepseek", { error: fail("deepseek", "server") });
    const brave = new FakeProvider("brave");
    const tavily = new FakeProvider("tavily");
    const glm = new FakeProvider("glm");
    const { router: r, traces } = router([deepseek, brave, tavily, glm]);

    const { hits } = await r.search(SIMPLE, {});

    // After DeepSeek, the plan's next tier is [tavily, brave]; the first call starts it at tavily.
    expect(hits[0]!.source).toBe("tavily");
    expect(traces[0]!.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ["deepseek", false],
      ["tavily", true],
    ]);
    expect(brave.requests).toHaveLength(0);
    expect(glm.requests).toHaveLength(0);
  });

  it("treats an empty answer as a reason to try the next provider, not as success", async () => {
    const deepseek = new FakeProvider("deepseek", { hits: [] });
    const brave = new FakeProvider("brave");
    const { router: r } = router([deepseek, brave]);

    const { hits } = await r.search(SIMPLE, {});

    expect(hits[0]!.source).toBe("brave");
  });

  it("reports an honest empty result when every provider answered but found nothing", async () => {
    const { router: r } = router([new FakeProvider("deepseek", { hits: [] }), new FakeProvider("brave", { hits: [] })]);

    const { hits, trace } = await r.search(SIMPLE, {});

    expect(hits).toEqual([]);
    expect(trace.attempts.every((a) => a.ok)).toBe(true);
  });

  it("raises one error naming each provider's failure when none can answer", async () => {
    const { router: r } = router([
      new FakeProvider("deepseek", { error: fail("deepseek", "quota") }),
      new FakeProvider("brave", { error: fail("brave", "timeout") }),
    ]);

    const error = await r.search(SIMPLE, {}).catch((e) => e);

    expect(error).toBeInstanceOf(SearchUnavailableError);
    expect(error.message).toContain("deepseek (quota");
    expect(error.message).toContain("brave (timeout");
    expect(error.attempts).toHaveLength(2);
  });

  it("keeps a provider that is out of quota off the path until its cool-down ends", async () => {
    let now = 0;
    const health = new SearchHealth({ now: () => now });
    const deepseek = new FakeProvider("deepseek", { error: fail("deepseek", "quota") });
    const brave = new FakeProvider("brave");
    const { router: r } = router([deepseek, brave], { health, now: () => now });

    await r.search(SIMPLE, {});
    await r.search(SIMPLE, {});
    expect(deepseek.requests).toHaveLength(1); // not asked the second time

    now += 15 * 60_000 + 1;
    deepseek.behavior = { hits: ["https://deepseek.example/back"] };
    const { hits } = await r.search(SIMPLE, {});
    expect(hits[0]!.source).toBe("deepseek");
  });

  it("does not stall on a provider that never answers: it times out and the chain moves on", async () => {
    const slow = new FakeProvider("deepseek", { delayMs: 500, hits: ["https://slow.example"] });
    const brave = new FakeProvider("brave");
    const { router: r } = router([slow, brave], { perProviderTimeoutMs: 250 });
    // The fake ignores the timeout it is handed, so the router must not wait past its deadline either.
    vi.spyOn(slow, "search").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw fail("deepseek", "timeout");
    });

    const { hits } = await r.search(SIMPLE, {});

    expect(hits[0]!.source).toBe("brave");
  });
});

describe("SearchRouter: rotation", () => {
  it("alternates between providers that share a tier so load and free quotas spread evenly", async () => {
    const deepseek = new FakeProvider("deepseek", { error: fail("deepseek", "quota") });
    const brave = new FakeProvider("brave");
    const tavily = new FakeProvider("tavily");
    const { router: r } = router([deepseek, brave, tavily]);

    const winners: string[] = [];
    for (let i = 0; i < 4; i += 1) winners.push((await r.search(SIMPLE, {})).hits[0]!.source);

    expect(winners).toEqual(["tavily", "brave", "tavily", "brave"]);
  });

  it("keeps a provider that is slow to reach cold behind the others until it has warmed up", async () => {
    const deepseek = new FakeProvider("deepseek", { error: fail("deepseek", "quota") });
    const brave = Object.assign(new FakeProvider("brave"), { slowCold: true });
    const tavily = Object.assign(new FakeProvider("tavily"), { slowCold: true });
    const glm = new FakeProvider("glm");
    const { router: r } = router([deepseek, brave, tavily, glm]);
    // Only tavily finishes warming; brave would still be paying its multi-second handshake.
    vi.spyOn(brave, "warm").mockImplementation(() => new Promise(() => {}));
    r.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const winners: string[] = [];
    for (let i = 0; i < 3; i += 1) winners.push((await r.search(SIMPLE, {})).hits[0]!.source);
    r.stop();

    expect(winners).toEqual(["tavily", "tavily", "tavily"]);
  });

  it("does not demote a fast-to-connect provider just because its warm-up has not returned", async () => {
    const deepseek = new FakeProvider("deepseek");
    const glm = new FakeProvider("glm");
    const { router: r } = router([deepseek, glm]);
    vi.spyOn(deepseek, "warm").mockImplementation(() => new Promise(() => {}));
    r.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const { hits } = await r.search(SIMPLE, {});
    r.stop();

    expect(hits[0]!.source).toBe("deepseek");
  });
});

describe("SearchRouter: fan-out", () => {
  const HARD = "PostgreSQL 和 MySQL 的区别与优缺点对比";

  it("asks two providers at once and fuses them, rewarding pages both return", async () => {
    const deepseek = new FakeProvider("deepseek", { hits: ["https://only-d.example", "https://shared.example/x"] });
    const tavily = new FakeProvider("tavily", { hits: ["https://only-t.example", "http://www.shared.example/x/"] });
    const { router: r, traces } = router([deepseek, tavily, new FakeProvider("brave")]);

    const { hits, trace } = await r.search(HARD, { count: 3 });

    expect(hits[0]).toMatchObject({ url: "https://shared.example/x", agreedBy: ["deepseek", "tavily"] });
    expect(traces[0]!.plan).toBe("fanout/2/-/general");
    expect(trace.contributors.sort()).toEqual(["deepseek", "tavily"]);
  });

  it("does not wait for a slow second source beyond the grace window", async () => {
    const fast = new FakeProvider("deepseek");
    const slow = new FakeProvider("tavily", { delayMs: 400 });
    const { router: r } = router([fast, slow], { fanoutGraceMs: 20 });

    const started = Date.now();
    const { hits, trace } = await r.search(HARD, {});

    expect(Date.now() - started).toBeLessThan(250);
    expect(hits.every((h) => h.source === "deepseek")).toBe(true);
    expect(trace.contributors).toEqual(["deepseek"]);
  });

  it("still answers from the survivor when one of the fanned-out providers fails", async () => {
    const { router: r } = router([new FakeProvider("deepseek", { error: fail("deepseek", "server") }), new FakeProvider("tavily")]);

    const { hits } = await r.search(HARD, {});

    expect(hits[0]!.source).toBe("tavily");
  });

  it("widens a simple-looking question when the refinement says it needs cross-checking", async () => {
    const [deepseek, brave] = [new FakeProvider("deepseek"), new FakeProvider("brave")];
    const refine = vi.fn(async ({ rule }: { rule: SearchPlan }): Promise<SearchPlan> => ({ ...rule, mode: "fanout", width: 2 }));
    const { router: r, traces } = router([deepseek, brave], { refine });

    const { trace } = await r.search(SIMPLE, {});

    expect(refine).toHaveBeenCalledWith(expect.objectContaining({ query: SIMPLE }));
    expect(deepseek.requests).toHaveLength(1);
    expect(brave.requests).toHaveLength(1);
    expect(trace.contributors.sort()).toEqual(["brave", "deepseek"]);
    expect(traces[0]).toMatchObject({ plan: "fanout/2/-/general", refined: true });
  });

  it("starts the first provider without waiting for the refinement, then applies it", async () => {
    const deepseek = new FakeProvider("deepseek");
    const refine = vi.fn(() => new Promise<SearchPlan>((resolve) => setTimeout(() => resolve(planByRules(SIMPLE)), 60)));
    const { router: r } = router([deepseek], { refine });

    const pending = r.search(SIMPLE, {});
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(deepseek.requests).toHaveLength(1); // already asked while the refinement is still thinking
    await pending;
  });

  it("falls back to the rule plan when the refinement fails", async () => {
    const deepseek = new FakeProvider("deepseek");
    const { router: r } = router([deepseek], { refine: async () => Promise.reject(new Error("jev down")) });

    const { hits } = await r.search(SIMPLE, {});

    expect(hits[0]!.source).toBe("deepseek");
  });

  it("passes freshness, topic and depth to the providers", async () => {
    const deepseek = new FakeProvider("deepseek");
    const tavily = new FakeProvider("tavily");
    const { router: r } = router([deepseek, tavily]);

    await r.search("请深入全面研究一下今天的新闻", {});

    expect(tavily.requests[0]).toMatchObject({ topic: "news", recency: "day", deep: true });
  });
});

describe("SearchRouter: lifecycle", () => {
  it("warms every provider on start, keeps them warm, and closes them on stop", async () => {
    const providers = [new FakeProvider("deepseek"), new FakeProvider("brave")];
    const { router: r } = router(providers, { keepAliveIntervalMs: 20 });

    r.start();
    await new Promise((resolve) => setTimeout(resolve, 70));
    r.stop();

    expect(providers.every((p) => p.warmed >= 2)).toBe(true);
    expect(providers.every((p) => p.closed)).toBe(true);
  });

  it("exposes provider health for diagnostics", async () => {
    const { router: r } = router([new FakeProvider("deepseek", { error: fail("deepseek", "quota") }), new FakeProvider("brave")]);
    await r.search(SIMPLE, {});

    expect(r.healthSnapshot().find((h) => h.id === "deepseek")).toMatchObject({ available: false, failures: 1 });
  });
});
