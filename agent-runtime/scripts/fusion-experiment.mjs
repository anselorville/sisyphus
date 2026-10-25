#!/usr/bin/env node
/**
 * Offline comparison of ways to fuse the four providers' ranked lists, on the
 * frozen pool (eval/search-pool.json) and its relevance labels
 * (eval/search-judgments.json).
 *
 *   node scripts/fusion-experiment.mjs [--judge=both|jev|deepseek] [--repeats=20] [--providers=deepseek,glm,tavily,brave]
 *
 * Only queries on which every listed provider answered are used.
 *
 * Strategies (all fuse the same four lists, top-5 scored by nDCG@5):
 *   single:<p>      one provider alone
 *   rrf             the shipped fuser: equal weights, k=60
 *   global-tuned    one (k, weights) for every query, picked on training folds
 *   adaptive        a (k, weights) per query category, picked on training folds,
 *                   shrunk toward the global choice so a small category cannot overfit
 *   oracle          the best config per query, chosen with the answer in hand: an
 *                   upper bound on what ANY per-query weighting could reach
 *
 * Tuned strategies are scored only on queries held out from their tuning (repeated
 * stratified k-fold). Differences to rrf get a paired bootstrap interval.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalUrl } from "../dist/search/fuse.js";

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const JUDGE = arg("judge", "both");
const REPEATS = Number(arg("repeats", "20"));
const FOLDS = 5;
// e.g. --candidate=deepseek:3,tavily:1,brave:2 : a fixed config reported next to the tuned ones (its weights were chosen on this data, so it is optimistic)
const CANDIDATE = arg("candidate", "");
const CANDIDATE_WEIGHTS = Object.fromEntries(CANDIDATE.split(",").filter(Boolean).map((x) => [x.split(":")[0], Number(x.split(":")[1])]));
const TOP = 5;
const SHRINK = 14; // pseudo-queries of global evidence mixed into every category choice

const read = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../eval/${name}`, import.meta.url)), "utf8"));
const pool = read("search-pool.json");
const judgments = read("search-judgments.json");

const PROVIDERS = arg("providers", "deepseek,glm,tavily,brave").split(",");
const KS = [10, 30, 60];
const WEIGHTS = [0.5, 1, 2, 3];

// --- data ---------------------------------------------------------------------
function gainOf(j) {
  if (!j) return 0;
  const vals = JUDGE === "jev" ? [j.jev] : JUDGE === "deepseek" ? [j.deepseek] : [j.jev, j.deepseek];
  const ok = vals.filter((v) => typeof v === "number");
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0;
}

const queries = pool
  .filter((entry) => judgments[entry.id])
  .map((entry) => {
    const lists = PROVIDERS.map((p) => (entry.lists[p] ?? []).map((h) => canonicalUrl(h.url)));
    const gain = new Map();
    for (const [key, j] of Object.entries(judgments[entry.id])) gain.set(key, gainOf(j));
    const ideal = [...gain.values()].sort((a, b) => b - a).slice(0, TOP);
    return { id: entry.id, category: entry.category, query: entry.query, lists, gain, idcg: dcg(ideal) };
  })
  // A provider that errored (GLM ran out of quota part-way) would otherwise count as "returned nothing".
  .filter((q) => q.lists.every((l) => l.length > 0))
  .filter((q) => q.idcg > 0); // nothing relevant anywhere in the pool: no ranking can score

function dcg(gains) {
  return gains.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
}

function fuseKeys(lists, weights, k) {
  const score = new Map();
  lists.forEach((list, p) => {
    if (weights[p] === 0) return;
    list.forEach((key, i) => score.set(key, (score.get(key) ?? 0) + weights[p] / (k + i + 1)));
  });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([key]) => key);
}

function ndcg(q, keys) {
  return dcg(keys.map((key) => q.gain.get(key) ?? 0)) / q.idcg;
}

// --- configs ------------------------------------------------------------------
const configs = [];
const weightGrid = PROVIDERS.reduce((acc) => acc.flatMap((w) => WEIGHTS.map((x) => [...w, x])), [[]]);
for (const k of KS) for (const w of weightGrid) configs.push({ k, w });
const RRF = configs.findIndex((c) => c.k === 60 && c.w.every((x) => x === 1));
const label = (c) => `k=${c.k} ${PROVIDERS.map((p, i) => `${p}:${c.w[i]}`).join(" ")}`;

// score[c][q]: nDCG@5 of config c on query q
const score = configs.map((c) => queries.map((q) => ndcg(q, fuseKeys(q.lists, c.w, c.k))));
const single = PROVIDERS.map((_, p) => queries.map((q) => ndcg(q, q.lists[p].slice(0, TOP))));

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

// --- cross-validation ----------------------------------------------------------
function folds(seed) {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const byCategory = new Map();
  queries.forEach((q, i) => (byCategory.get(q.category) ?? byCategory.set(q.category, []).get(q.category)).push(i));
  const assigned = new Array(queries.length);
  for (const idx of byCategory.values()) {
    const shuffled = idx.map((i) => [rand(), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    shuffled.forEach((i, n) => (assigned[i] = n % FOLDS));
  }
  return assigned;
}

function bestConfig(trainIdx, globalTrainScore) {
  let best = 0;
  let bestValue = -1;
  for (let c = 0; c < configs.length; c += 1) {
    const value = mean(trainIdx.map((i) => score[c][i]));
    if (value > bestValue) ((bestValue = value), (best = c));
  }
  return best;
}

function bestShrunk(catIdx, allIdx) {
  let best = 0;
  let bestValue = -1;
  for (let c = 0; c < configs.length; c += 1) {
    const sum = catIdx.reduce((s, i) => s + score[c][i], 0);
    const globalMean = mean(allIdx.map((i) => score[c][i]));
    const value = (sum + SHRINK * globalMean) / (catIdx.length + SHRINK);
    if (value > bestValue) ((bestValue = value), (best = c));
  }
  return best;
}

const heldOut = { "global-tuned": new Array(queries.length).fill(0), adaptive: new Array(queries.length).fill(0) };
const chosenGlobal = new Map();
for (let r = 0; r < REPEATS; r += 1) {
  const fold = folds(1000 + r);
  for (let f = 0; f < FOLDS; f += 1) {
    const train = queries.map((_, i) => i).filter((i) => fold[i] !== f);
    const test = queries.map((_, i) => i).filter((i) => fold[i] === f);
    const g = bestConfig(train);
    chosenGlobal.set(g, (chosenGlobal.get(g) ?? 0) + 1);
    const perCategory = new Map();
    for (const q of new Set(queries.map((x) => x.category))) {
      perCategory.set(q, bestShrunk(train.filter((i) => queries[i].category === q), train));
    }
    for (const i of test) {
      heldOut["global-tuned"][i] += score[g][i] / REPEATS;
      heldOut.adaptive[i] += score[perCategory.get(queries[i].category)][i] / REPEATS;
    }
  }
}

const oracle = queries.map((_, i) => Math.max(...configs.map((_, c) => score[c][i])));
const rrf = score[RRF];

// --- report --------------------------------------------------------------------
function bootstrap(a, b, n = 10_000) {
  const diffs = a.map((x, i) => x - b[i]);
  let s = 12345;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const means = [];
  for (let t = 0; t < n; t += 1) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i += 1) sum += diffs[(rand() * diffs.length) | 0];
    means.push(sum / diffs.length);
  }
  means.sort((x, y) => x - y);
  const wins = diffs.filter((d) => d > 0.005).length;
  const losses = diffs.filter((d) => d < -0.005).length;
  return { diff: mean(diffs), lo: means[(n * 0.025) | 0], hi: means[(n * 0.975) | 0], wins, losses };
}

const fmt = (x) => x.toFixed(3);
const rows = [
  ...PROVIDERS.map((p, i) => [`single:${p}`, single[i]]),
  ["rrf (shipped)", rrf],
  ...(CANDIDATE ? [[`fixed: ${CANDIDATE} (in-sample)`, score[configs.findIndex((c) => c.k === 60 && PROVIDERS.every((p, i) => c.w[i] === (CANDIDATE_WEIGHTS[p] ?? 1)))]]] : []),
  ["global-tuned (held-out)", heldOut["global-tuned"]],
  ["adaptive by category (held-out)", heldOut.adaptive],
  ["oracle per query (upper bound)", oracle],
];
console.log(`judge=${JUDGE}  queries=${queries.length} (of ${pool.length}; the rest have nothing relevant in the pool)  metric=nDCG@${TOP}  ${REPEATS}x${FOLDS}-fold CV\n`);
console.log(`${"strategy".padEnd(36)}${"nDCG@5".padEnd(9)}${"vs rrf".padEnd(9)}${"95% CI".padEnd(20)}win/loss`);
for (const [name, values] of rows) {
  const b = bootstrap(values, rrf);
  console.log(`${name.padEnd(36)}${fmt(mean(values)).padEnd(9)}${(b.diff >= 0 ? "+" : "") + fmt(b.diff)}`.padEnd(54) + `[${fmt(b.lo)}, ${fmt(b.hi)}]`.padEnd(20) + `${b.wins}/${b.losses}`);
}

{
  const anchor = single[0];
  console.log(`\nagainst ${PROVIDERS[0]} alone (is fusing worth it at all?):`);
  for (const [name, values] of rows.slice(PROVIDERS.length + 1).filter(([n]) => n !== "rrf (shipped)")) {
    const b = bootstrap(values, anchor);
    console.log(`  ${name.padEnd(36)}${(b.diff >= 0 ? "+" : "") + fmt(b.diff)}  [${fmt(b.lo)}, ${fmt(b.hi)}]  win/loss ${b.wins}/${b.losses}`);
  }
}

console.log("\nper category (mean nDCG@5): rrf | adaptive | global-tuned | oracle | best single");
const categories = [...new Set(queries.map((q) => q.category))];
for (const cat of categories) {
  const idx = queries.map((q, i) => (q.category === cat ? i : -1)).filter((i) => i >= 0);
  const m = (values) => fmt(mean(idx.map((i) => values[i])));
  const bestSingle = PROVIDERS.map((p, k) => [p, mean(idx.map((i) => single[k][i]))]).sort((a, b) => b[1] - a[1])[0];
  console.log(`  ${cat.padEnd(20)} n=${String(idx.length).padEnd(3)} ${m(rrf)} | ${m(heldOut.adaptive)} | ${m(heldOut["global-tuned"])} | ${m(oracle)} | ${bestSingle[0]} ${fmt(bestSingle[1])}`);
}

console.log("\nbest config on ALL queries (in-sample, descriptive only):");
const ranked = configs.map((c, i) => [i, mean(score[i])]).sort((a, b) => b[1] - a[1]);
for (const [i, v] of ranked.slice(0, 3)) console.log(`  ${fmt(v)}  ${label(configs[i])}`);
console.log(`  rrf        ${fmt(mean(rrf))}  ${label(configs[RRF])}`);

console.log("\nbest config per category (in-sample, descriptive only):");
for (const cat of categories) {
  const idx = queries.map((q, i) => (q.category === cat ? i : -1)).filter((i) => i >= 0);
  const [i, v] = configs.map((c, k) => [k, mean(idx.map((j) => score[k][j]))]).sort((a, b) => b[1] - a[1])[0];
  console.log(`  ${cat.padEnd(20)} ${fmt(v)} (rrf ${fmt(mean(idx.map((j) => rrf[j])))})  ${label(configs[i])}`);
}

console.log("\nheadroom: queries where some config beats rrf by > 0.05 nDCG: " + oracle.filter((o, i) => o - rrf[i] > 0.05).length + "/" + queries.length);
console.log("most-picked global configs across folds:");
for (const [i, n] of [...chosenGlobal.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) console.log(`  ${String(n).padStart(3)}/${REPEATS * FOLDS}  ${label(configs[i])}`);
