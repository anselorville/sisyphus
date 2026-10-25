#!/usr/bin/env node
/**
 * Scores the per-turn decision (src/decision/turn-decision.ts) against the
 * labelled utterances in eval/turn-cases.json, using the REAL Jev service:
 *
 *   npm run build
 *   TYPESAFE_API_KEY=... node scripts/eval-turn-decision.mjs [--verbose] [--json out.json]
 *
 * It compares three policies on the same cases:
 *   rule      the deterministic ReflexRouter + strict answer rule (today's behaviour)
 *   jev       Jev alone, where it is confident (otherwise it "defers")
 *   combined  what `live` mode does: Jev when confident, the rule otherwise
 *
 * Re-run it whenever the questions, criteria or thresholds change: the specs
 * are versioned, and a threshold nobody has measured is a guess.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { JevClient } from "../dist/decision/jev-client.js";
import { classifyAnswerByRule, turnDecisionSpec } from "../dist/decision/turn-decision.js";
import {
  CODE_ROLE_MANIFEST,
  DEVICE_ROLE_MANIFEST,
  GENERAL_ROLE_MANIFEST,
  INSPECTOR_ROLE_MANIFEST,
  MAIL_ROLE_MANIFEST,
  MEMORY_ROLE_MANIFEST,
  SCRIBE_ROLE_MANIFEST,
  WEB_ROLE_MANIFEST,
} from "../dist/roles/manifests.js";
import { ReflexRouter } from "../dist/routing/reflex-router.js";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const cases = JSON.parse(readFileSync(fileURLToPath(new URL("../eval/turn-cases.json", import.meta.url)), "utf8"));

const manifests = [GENERAL_ROLE_MANIFEST, CODE_ROLE_MANIFEST, WEB_ROLE_MANIFEST, DEVICE_ROLE_MANIFEST, MAIL_ROLE_MANIFEST, INSPECTOR_ROLE_MANIFEST, MEMORY_ROLE_MANIFEST, SCRIBE_ROLE_MANIFEST];
const roles = manifests.filter((m) => m.routingHint).map((m) => ({ roleId: m.id, hint: m.routingHint }));
const reflex = new ReflexRouter();

const client = new JevClient({ apiKey: process.env.TYPESAFE_API_KEY, onWarn: (m) => console.error(`[jev] ${m}`) });
if (!client.enabled) {
  console.error("TYPESAFE_API_KEY is not set");
  process.exit(2);
}
client.start();
await client.whenWarm();
if (!client.isReady) {
  console.error("could not warm the Jev connection");
  process.exit(2);
}

const label = (outcome) => {
  const kind = outcome.route.kind;
  if (kind === "general_worker" || kind === "capability_match") return { type: "request", role: outcome.route.roleId, answer: outcome.answer };
  return { type: kind, answer: outcome.answer };
};

const correct = (expect, got) => {
  if (!got) return false;
  if (expect.type === "answer") return expect.answer === "not_confirm" ? got.answer !== "confirm" : got.answer === expect.answer;
  if (expect.type === "request") return got.type === "request" && got.role === expect.role;
  return got.type === expect.type;
};

const results = [];
for (const c of cases) {
  const active = c.active ? { taskId: "t-eval", roleId: c.active.roleId, goal: c.active.goal } : undefined;
  const input = { transcript: c.text, active, roles, pending: c.pending };
  const routeState = {
    activeTask: active ? { taskId: active.taskId, roleId: active.roleId } : undefined,
    capabilityProviders: manifests.map((m) => ({ roleId: m.id, capabilities: m.capabilities })),
  };

  // The rule baseline exactly as TurnDecider builds it.
  const ruleRoute = reflex.route(c.text, routeState);
  const ruleAnswer = c.pending ? classifyAnswerByRule(c.text) : undefined;
  const rule = label({ route: ruleRoute, answer: ruleAnswer });

  let jev;
  let raw;
  let latency;
  const started = Date.now();
  try {
    const { state, questions } = turnDecisionSpec.buildRequest(input);
    const response = await client.ask(state, questions, { timeoutMs: 5000 });
    latency = Date.now() - started;
    raw = Object.fromEntries(Object.entries(response.choices).map(([k, v]) => [k, `${v.choice} ${v.probabilities[v.choice].toFixed(2)}`]));
    const interpreted = turnDecisionSpec.interpret(response, input);
    if (interpreted) jev = label(interpreted.value);
  } catch (error) {
    raw = { error: String(error.message ?? error) };
  }
  const combined = jev ?? rule;
  // Explicit commands never reach Jev in production; mirror that.
  const explicit = ruleRoute.kind === "stop_speech" || ruleRoute.kind === "cancel";
  results.push({ ...c, rule, jev, combined: explicit ? rule : combined, deferred: !jev, raw, latency });
}

const pct = (n, d) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`);
const groups = ["request", "cancel", "steer", "follow_up", "stop_speech", "answer"];
const summary = {};
for (const policy of ["rule", "jev", "combined"]) {
  summary[policy] = {
    overall: results.filter((r) => correct(r.expect, r[policy])).length,
    byType: Object.fromEntries(groups.map((g) => [g, results.filter((r) => r.expect.type === g && correct(r.expect, r[policy])).length])),
  };
}
const totals = Object.fromEntries(groups.map((g) => [g, results.filter((r) => r.expect.type === g).length]));
const falseConfirm = (policy) => results.filter((r) => r.expect.type === "answer" && r.expect.answer !== "confirm" && r[policy]?.answer === "confirm").length;
const missedConfirm = (policy) => results.filter((r) => r.expect.type === "answer" && r.expect.answer === "confirm" && r[policy]?.answer !== "confirm").length;
const latencies = results.map((r) => r.latency).filter((x) => x !== undefined).sort((a, b) => a - b);
const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];

console.log(`\n${results.length} labelled utterances\n`);
console.log("accuracy".padEnd(14) + "rule".padEnd(16) + "jev (confident)".padEnd(18) + "combined");
console.log("overall".padEnd(14) + [summary.rule, summary.jev, summary.combined].map((s) => pct(s.overall, results.length).padEnd(16)).join(""));
for (const g of groups) {
  console.log(g.padEnd(14) + [summary.rule, summary.jev, summary.combined].map((s) => pct(s.byType[g], totals[g]).padEnd(16)).join(""));
}
console.log(`\nJev deferred to the rule on ${results.filter((r) => r.deferred).length}/${results.length} utterances`);
console.log(`FALSE confirmations (consent read into a non-yes):  rule ${falseConfirm("rule")}  jev ${falseConfirm("jev")}  combined ${falseConfirm("combined")}`);
console.log(`missed confirmations (a real yes not recognised):    rule ${missedConfirm("rule")}  jev ${missedConfirm("jev")}  combined ${missedConfirm("combined")}`);
console.log(`Jev latency over a warm connection: p50 ${at(0.5)}ms  p95 ${at(0.95)}ms  max ${latencies.at(-1)}ms`);
console.log(`client stats: ${JSON.stringify(client.stats())}`);

const show = (r) => `#${r.id} ${JSON.stringify(r.text)} expect=${JSON.stringify(r.expect)} rule=${JSON.stringify(r.rule)} jev=${r.jev ? JSON.stringify(r.jev) : "deferred"} raw=${JSON.stringify(r.raw)}`;
const wrong = results.filter((r) => !correct(r.expect, r.combined));
console.log(`\ncombined policy is wrong on ${wrong.length} case(s):`);
for (const r of wrong) console.log("  " + show(r));
if (verbose) {
  console.log("\nwhere Jev and the rule disagree:");
  for (const r of results.filter((r) => r.jev && JSON.stringify(r.jev) !== JSON.stringify(r.rule))) console.log("  " + show(r));
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, totals, results }, null, 1));
client.stop();
