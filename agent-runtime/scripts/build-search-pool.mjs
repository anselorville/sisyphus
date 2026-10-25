#!/usr/bin/env node
/**
 * Freezes what each search provider returns for the evaluation queries, so
 * fusion strategies can be compared offline on identical inputs.
 *
 *   npm run build && set -a && . ../.env && set +a
 *   node scripts/build-search-pool.mjs            # resumes if eval/search-pool.json exists
 *
 * Every provider gets the same request (top 8, with the freshness and topic the
 * rule planner would choose for the query). The output keeps title, url, rank,
 * the provider's own score/date and a short snippet (the judge needs it).
 * It spends a few hundred search calls of quota.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createSearchProviders } from "../dist/search/factory.js";
import { planByRules } from "../dist/search/planner.js";

const QUERIES = JSON.parse(readFileSync(fileURLToPath(new URL("../eval/search-queries.json", import.meta.url)), "utf8"));
const OUT = fileURLToPath(new URL("../eval/search-pool.json", import.meta.url));
const TOP = 8;

const providers = createSearchProviders(process.env);
console.log(`providers: ${providers.map((p) => p.id).join(", ")}`);
await Promise.all(providers.map((p) => p.warm()));

const pool = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
const done = new Set(pool.map((entry) => entry.id));

async function ask(provider, request) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const hits = await provider.search(request, 12_000);
      return { hits };
    } catch (error) {
      // A rejected query (content filter) or an exhausted account will not change on retry.
      if (attempt === 1 || ["bad_request", "auth", "quota"].includes(error.kind)) return { error: `${error.kind}: ${String(error.message).slice(0, 100)}` };
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  return { error: "unreachable" };
}

for (const q of QUERIES) {
  if (done.has(q.id)) continue;
  const plan = planByRules(q.query);
  const request = { query: q.query, count: TOP, recency: plan.recency, topic: plan.topic };
  const started = Date.now();
  const results = await Promise.all(providers.map(async (p) => [p.id, await ask(p, request)]));
  const entry = { ...q, request: { recency: plan.recency ?? null, topic: plan.topic }, lists: {}, errors: {} };
  for (const [id, r] of results) {
    if (r.hits) {
      entry.lists[id] = r.hits.slice(0, TOP).map((h, i) => ({
        rank: i + 1,
        title: h.title,
        url: h.url,
        snippet: (h.snippet ?? "").slice(0, 400),
        score: h.score ?? null,
        publishedAt: h.publishedAt ?? null,
      }));
    } else entry.errors[id] = r.error;
  }
  pool.push(entry);
  writeFileSync(OUT, JSON.stringify(pool));
  const counts = providers.map((p) => `${p.id}:${entry.lists[p.id]?.length ?? "x"}`).join(" ");
  console.log(`#${q.id} ${q.category.padEnd(20)} ${String(Date.now() - started).padStart(5)}ms  ${counts}  ${q.query}`);
}

const failures = pool.flatMap((e) => Object.entries(e.errors).map(([id, msg]) => `${id}: ${msg}`));
console.log(`\n${pool.length} queries pooled. provider failures: ${failures.length}`);
for (const [msg, n] of Object.entries(failures.reduce((m, f) => ({ ...m, [f]: (m[f] ?? 0) + 1 }), {}))) console.log(`  ${n}x ${msg}`);
providers.forEach((p) => p.close());
