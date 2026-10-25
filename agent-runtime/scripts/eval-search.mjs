#!/usr/bin/env node
/**
 * Checks the web search layer against the REAL providers.
 *
 *   npm run build
 *   set -a; . ../.env; set +a
 *   node scripts/eval-search.mjs [--verbose] [--no-jev]
 *
 * 1. Each provider alone: latency over a warm connection and how often one of a
 *    few well-known domains appears in its top results for a question whose
 *    right source is not in doubt ("domain hit"). It is a smoke test for "does
 *    this provider return sensible pages", not a relevance benchmark.
 * 2. The router: which providers it used for each question, and the end-to-end
 *    time, in single and fan-out modes.
 * 3. Fault injection: a provider is made to fail and the chain must still answer.
 *
 * It spends a few cents of API quota.
 */

import { DecisionEngine } from "../dist/decision/decision-engine.js";
import { JevClient } from "../dist/decision/jev-client.js";
import { createSearchProviders } from "../dist/search/factory.js";
import { planByRules, searchPlanSpec } from "../dist/search/planner.js";
import { SearchRouter } from "../dist/search/router.js";
import { SearchError } from "../dist/search/types.js";

const verbose = process.argv.includes("--verbose");
const useJev = !process.argv.includes("--no-jev");

// question, domains that would be a right answer, expected nature of the plan
const CASES = [
  ["今天上海天气怎么样", ["weather", "cma.cn", "tianqi", "moji", "nmc.cn", "qweather"]],
  ["Node.js 22 LTS release date", ["nodejs.org", "github.com/nodejs", "endoflife.date"]],
  ["Python 3.14 有哪些新特性", ["python.org", "docs.python", "realpython"]],
  ["Anthropic latest Claude model release", ["anthropic.com", "docs.anthropic"]],
  ["诺贝尔物理学奖 最新得主", ["nobelprize.org", "xinhuanet", "people.com", "thepaper", "sina", "163.com", "qq.com"]],
  ["PostgreSQL 和 MySQL 的区别与优缺点对比", ["postgresql", "mysql", "aws.amazon", "ibm.com", "oracle", "runoob", "cnblogs", "zhihu", "csdn", "juejin"]],
  ["how does Raft consensus handle leader election", ["raft.github.io", "wikipedia", "etcd", "thesecretlivesofdata", "geeksforgeeks", "medium"]],
  ["英伟达最新财报 营收", ["nvidia", "investing", "sina", "eastmoney", "xueqiu", "cnbc", "reuters", "10jqka", "163.com"]],
];

const providers = createSearchProviders(process.env);
if (providers.length === 0) {
  console.error("no search provider has a key in the environment");
  process.exit(2);
}
const ids = providers.map((p) => p.id);
console.log(`providers: ${ids.join(", ")}\n`);

// Open every connection once; the first call to an overseas host would otherwise be ~6s of TLS.
const warmStart = Date.now();
await Promise.all(providers.map((p) => p.warm()));
console.log(`warm-up: ${Date.now() - warmStart}ms\n`);

const hitDomain = (hits, domains) => hits.some((h) => domains.some((d) => h.url.toLowerCase().includes(d)));

// --- 1. each provider alone -------------------------------------------------
console.log("1) each provider alone (warm connection, top 5)");
const stats = Object.fromEntries(ids.map((id) => [id, { ok: 0, hit: 0, ms: [], fails: [] }]));
for (const [query, domains] of CASES) {
  for (const provider of providers) {
    const plan = planByRules(query);
    const started = Date.now();
    try {
      const hits = await provider.search({ query, count: 5, recency: plan.recency, topic: plan.topic }, 8000);
      const ms = Date.now() - started;
      const s = stats[provider.id];
      s.ms.push(ms);
      if (hits.length > 0) s.ok += 1;
      if (hitDomain(hits, domains)) s.hit += 1;
      if (verbose) console.log(`   ${provider.id.padEnd(9)} ${String(ms).padStart(5)}ms n=${hits.length} ${hits[0]?.url ?? "-"}  <- ${query}`);
    } catch (error) {
      stats[provider.id].fails.push(`${error.kind ?? "error"}: ${String(error.message).slice(0, 60)}`);
      if (verbose) console.log(`   ${provider.id.padEnd(9)} FAIL ${error.kind}: ${String(error.message).slice(0, 80)}  <- ${query}`);
    }
  }
}
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : undefined);
console.log(`   ${"provider".padEnd(10)}${"answered".padEnd(12)}${"domain hit".padEnd(13)}${"median ms".padEnd(11)}failures`);
for (const id of ids) {
  const s = stats[id];
  console.log(`   ${id.padEnd(10)}${`${s.ok}/${CASES.length}`.padEnd(12)}${`${s.hit}/${CASES.length}`.padEnd(13)}${String(median(s.ms) ?? "-").padEnd(11)}${[...new Set(s.fails)].join(" | ") || "-"}`);
}

// --- 2. the router ----------------------------------------------------------
let engine;
let jev;
if (useJev && process.env.TYPESAFE_API_KEY) {
  jev = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY, onWarn: () => {} });
  jev.start();
  await jev.whenWarm();
  engine = new DecisionEngine({ client: jev, mode: "live" });
}
const traces = [];
const router = new SearchRouter({
  providers,
  refine: engine ? (input) => engine.decide(searchPlanSpec, input, input.rule) : undefined,
  onSearch: (t) => traces.push(t),
});
router.start();
await router.whenWarm();

console.log(`\n2) the router${engine ? " (Jev refines the plan)" : " (rule plans only)"}`);
let routerHits = 0;
const latencies = [];
for (const [query, domains] of CASES) {
  const started = Date.now();
  try {
    const { hits, trace } = await router.search(query, { count: 5 });
    const ms = Date.now() - started;
    latencies.push(ms);
    if (hitDomain(hits, domains)) routerHits += 1;
    const agreed = hits.filter((h) => h.agreedBy.length > 1).length;
    console.log(`   ${String(ms).padStart(5)}ms  ${trace.plan.padEnd(22)} ${trace.contributors.join("+").padEnd(26)} agreed=${agreed}  ${trace.refined ? "[refined] " : ""}${query}`);
  } catch (error) {
    console.log(`   FAIL ${error.message}  <- ${query}`);
  }
}
console.log(`   domain hit ${routerHits}/${CASES.length}, median ${median(latencies)}ms`);

// --- 3. fault injection -----------------------------------------------------
console.log("\n3) fault injection: the preferred provider is made to fail");
const failing = providers.map((p) =>
  p.id === "deepseek"
    ? { id: p.id, warm: () => p.warm(), close: () => {}, search: async () => { throw new SearchError(p.id, "quota", "injected: balance exhausted"); } }
    : p,
);
const degraded = new SearchRouter({ providers: failing });
degraded.start();
await degraded.whenWarm();
for (const query of ["Node.js 22 LTS release date", "今天上海天气怎么样", "Python 3.14 有哪些新特性"]) {
  const started = Date.now();
  try {
    const { hits, trace } = await degraded.search(query, { count: 5 });
    console.log(`   ${String(Date.now() - started).padStart(5)}ms  answered by ${trace.contributors.join("+")} after ${trace.attempts.map((a) => `${a.provider}:${a.ok ? "ok" : "fail"}`).join(" -> ")}  (${hits.length} hits)`);
  } catch (error) {
    console.log(`   FAIL ${error.message}`);
  }
}
console.log(`   health: ${degraded.healthSnapshot().map((h) => `${h.id}=${h.available ? "up" : "benched"}`).join(" ")}`);

router.stop();
degraded.stop();
jev?.stop();
