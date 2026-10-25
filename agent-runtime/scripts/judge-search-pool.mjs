#!/usr/bin/env node
/**
 * Labels the relevance of every candidate in eval/search-pool.json with two
 * independent judges, so a fusion experiment has something to measure against.
 *
 *   npm run build && set -a && . ../.env && set +a
 *   node scripts/judge-search-pool.mjs            # resumes; writes eval/search-judgments.json
 *
 * - Jev: one call per query; each candidate gets a Score question (0 irrelevant,
 *   1 partly, 2 directly answers) about its own entry in the shared state.
 * - DeepSeek: one call per query grades all of that query's candidates 0-2 as JSON.
 *
 * Both judge only the title, snippet, url and date a provider returned, which is
 * also all a fuser sees, so this measures "did the ranking put useful-looking
 * results first". It does not open pages. Labels are model-made; the experiment
 * reports how well the two judges agree so that is visible.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { JevClient } from "../dist/decision/jev-client.js";
import { canonicalUrl } from "../dist/search/fuse.js";

const POOL = JSON.parse(readFileSync(fileURLToPath(new URL("../eval/search-pool.json", import.meta.url)), "utf8"));
const OUT = fileURLToPath(new URL("../eval/search-judgments.json", import.meta.url));
const TODAY = "2026-10-25";
const DEEPSEEK_MODEL = process.env.JUDGE_DEEPSEEK_MODEL ?? "deepseek-flash";

const judgments = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};

const jev = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY, onWarn: () => {} });
jev.start();
await jev.whenWarm();

const SCORE_CRITERIA = [
  "The result is unrelated to the query, or is a generic page (homepage, login, listing) that cannot help answer it.",
  "The result is on the topic and might help, but does not itself answer the query or is clearly outdated or about something adjacent.",
  "The result directly answers the query or is the authoritative page for it, and its date is acceptable for the query.",
];

/** Unique candidates of one query, keyed by canonical URL; first sighting supplies the text. */
function candidatesOf(entry) {
  const map = new Map();
  for (const hits of Object.values(entry.lists)) {
    for (const h of hits) {
      const key = canonicalUrl(h.url);
      if (!map.has(key)) map.set(key, { key, title: h.title, url: h.url, snippet: h.snippet, publishedAt: h.publishedAt });
    }
  }
  return [...map.values()];
}

/**
 * One Jev call per query: the candidates sit in the state once and each gets its own Score
 * question. Measured: a call costs ~0.35s whether it carries 1 or 64 questions, but 8 calls in
 * parallel take 1.4s and 24 take 4.2s, so many small parallel calls are the slow shape.
 */
async function jevScores(query, cands) {
  const state = {
    today: TODAY,
    search_query: query,
    results: cands.map((c) => ({ title: c.title, url: c.url, published: c.publishedAt, snippet: c.snippet.slice(0, 300) })),
  };
  const questions = Object.fromEntries(
    cands.map((_, i) => [`r${i}`, { type: "score", instructions: `How well does the search result \`results[${i}]\` serve the \`search_query\`? Judge only from what is shown.`, criteria: SCORE_CRITERIA }]),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const r = await jev.ask(state, questions, { timeoutMs: 15_000 });
      return cands.map((_, i) => r.scores[`r${i}`]?.score ?? null);
    } catch {
      await new Promise((r2) => setTimeout(r2, 500 * (attempt + 1)));
    }
  }
  return cands.map(() => null);
}

async function deepseekGrades(entry, cands) {
  const list = cands.map((c, i) => `[${i}] ${c.title}\n    ${c.url}${c.publishedAt ? `  (${c.publishedAt})` : ""}\n    ${c.snippet.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const prompt = `Today is ${TODAY}. Grade how well each web search result serves the search query, judging only from what is shown.\n0 = unrelated, or a generic page that cannot help answer it\n1 = on topic and might help, but does not itself answer it, or is outdated or adjacent\n2 = directly answers the query or is the authoritative page for it, with an acceptable date\n\nQuery: ${entry.query}\n\nResults:\n${list}\n\nReply with only a JSON object mapping each result number to its grade, like {\"0\": 2, \"1\": 0}, covering all ${cands.length} results.`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({ model: DEEPSEEK_MODEL, temperature: 0, thinking: { type: "disabled" }, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const text = (await res.json()).choices?.[0]?.message?.content ?? "";
      if (process.env.JUDGE_DEBUG) console.error("deepseek reply:", JSON.stringify(text).slice(0, 300));
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "null");
      const grades = cands.map((_, i) => parsed?.[String(i)]);
      // An unnumbered or short reply is retried rather than guessed at.
      if (grades.every((g) => [0, 1, 2].includes(g))) return grades;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  return null;
}

for (const entry of POOL) {
  if (judgments[entry.id]) continue;
  const cands = candidatesOf(entry);
  const started = Date.now();
  const [jevResult, dsGrades] = await Promise.all([jevScores(entry.query, cands), deepseekGrades(entry, cands)]);
  judgments[entry.id] = Object.fromEntries(cands.map((c, i) => [c.key, { jev: jevResult[i], deepseek: dsGrades?.[i] ?? null }]));
  writeFileSync(OUT, JSON.stringify(judgments));
  const missing = cands.filter((_, i) => jevResult[i] === null).length;
  console.log(`#${entry.id} ${String(cands.length).padStart(3)} candidates ${String(Date.now() - started).padStart(6)}ms  jev-missing=${missing} deepseek=${dsGrades ? "ok" : "FAILED"}  ${entry.query}`);
}

const s = jev.stats();
console.log(`done. jev calls=${s.calls ?? "?"} est. cost=$${(s.estimatedCostUsd ?? 0).toFixed(4)}`);
jev.stop();
