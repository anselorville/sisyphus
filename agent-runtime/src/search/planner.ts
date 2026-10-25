/**
 * How to search for a particular question: one source or several, which ones
 * first, and whether to ask for fresh results.
 *
 * Two layers, following the decision-layer pattern (../decision/): a
 * deterministic rule planner that is always available and instant, and a Jev
 * refinement that judges the question's difficulty and how fast its answer goes
 * stale. The router runs the refinement in parallel with the first provider
 * call, so it costs no extra latency, and falls back to the rule plan whenever
 * Jev is off, slow or unsure.
 */

import type { DecisionSpec } from "../decision/decision-engine.js";
import type { JevQuestion } from "../decision/jev-client.js";
import type { Recency, SearchTopic } from "./types.js";

export interface SearchPlan {
  /** `single` asks one provider (falling back down the chain); `fanout` asks several at once and fuses the results. */
  readonly mode: "single" | "fanout";
  /** How many providers the first wave asks. */
  readonly width: number;
  /** Preference tiers; providers in one tier are rotated so load (and free quotas) spread evenly. */
  readonly tiers: readonly (readonly string[])[];
  readonly topic: SearchTopic;
  readonly recency?: Recency;
  /** Pay for more recall where a provider has an "advanced" tier. */
  readonly deep: boolean;
}

const CJK = /[㐀-鿿]/g;

const DAY = /(今天|今日|刚刚|现在|实时|此刻|当前|天气|气温|股价|汇率|比分|today|right now|breaking|live score|tonight|currently)/i;
const WEEK = /(本周|这周|最近|近期|最新|新闻|快讯|latest|recent|this week|news|just (released|announced))/i;
const MONTH = /(本月|这个月|this month)/i;
const NEWS = /(新闻|快讯|头条|报道|发布会|news|headline|breaking)/i;
const HARD = /(对比|比较|区别|差异|优缺点|利弊|为什么|原理|分析|综述|研究|评测|如何选择|compare|versus|\bvs\b|difference between|pros and cons|trade-?off|why (does|do|is)|how does|analysis|review of|best way)/i;
const RESEARCH = /(综述|研究|详细|深入|全面|survey|in[- ]depth|comprehensive|literature)/i;
const PRECISE = /(\bsite:|"[^"]{3,}")/i;

export function isMostlyChinese(text: string): boolean {
  const total = [...text].filter((c) => /\S/.test(c)).length;
  return total > 0 && (text.match(CJK)?.length ?? 0) / total >= 0.3;
}

export function planByRules(query: string): SearchPlan {
  const chars = [...query].length;
  const news = NEWS.test(query);
  const recency: Recency | undefined = DAY.test(query) ? "day" : WEEK.test(query) ? "week" : MONTH.test(query) ? "month" : undefined;
  const hard = !PRECISE.test(query) && (chars >= 40 || HARD.test(query));
  const deep = hard && RESEARCH.test(query);
  const chinese = isMostlyChinese(query);

  const tiers = news || recency
    ? [["deepseek"], ["tavily"], ["brave"], ["glm"]]
    : chinese && hard
      ? [["deepseek"], ["glm"], ["tavily", "brave"]]
      : [["deepseek"], ["tavily", "brave"], ["glm"]];

  return {
    mode: hard ? "fanout" : "single",
    width: hard ? (deep ? 3 : 2) : 1,
    tiers,
    topic: news ? "news" : "general",
    ...(recency ? { recency } : {}),
    deep,
  };
}

// ---------------------------------------------------------------------------
// Jev refinement
// ---------------------------------------------------------------------------

export interface SearchPlanInput {
  readonly query: string;
  readonly rule: SearchPlan;
}

const DIFFICULTY_THRESHOLD = 0.6;
const RECENCY_THRESHOLD = 0.6;

function describePlan(plan: SearchPlan): string {
  return `${plan.mode}/${plan.width}/${plan.recency ?? "-"}/${plan.topic}${plan.deep ? "/deep" : ""}`;
}

export const searchPlanSpec: DecisionSpec<SearchPlanInput, SearchPlan> = {
  name: "search_plan",
  version: "1",
  budgetMs: 450,

  buildRequest(input) {
    const questions: Record<string, JevQuestion> = {
      difficulty: {
        type: "choice",
        instructions: "How much searching does answering this web search query well require?",
        criteria: {
          lookup: "One fact, definition, or page answers it: a single source is enough.",
          multi_facet: "It needs several facts, or a comparison, drawn from more than one source.",
          research: "Open-ended research: broad coverage and cross-checking between independent sources matter.",
        },
      },
      freshness: {
        type: "choice",
        instructions: "How quickly does the correct answer to this query go out of date?",
        criteria: {
          stable: "It does not change: history, definitions, how-to, established facts.",
          weeks: "It changes over weeks: recent releases, developments, 'latest' versions.",
          hours: "It changes by the hour or day: weather, prices, scores, breaking news, anything 'today' or 'now'.",
        },
      },
    };
    return { state: { search_query: input.query }, questions };
  },

  interpret(response, input) {
    const difficulty = response.choices["difficulty"];
    const freshness = response.choices["freshness"];
    if (!difficulty || !freshness) return undefined;
    if ((difficulty.probabilities[difficulty.choice] ?? 0) < DIFFICULTY_THRESHOLD) return undefined;

    const rule = input.rule;
    const freshProbability = freshness.probabilities[freshness.choice] ?? 0;
    // Only a confident reading changes the rule's idea of how fresh results must be.
    const recency: Recency | undefined =
      freshProbability < RECENCY_THRESHOLD
        ? rule.recency
        : freshness.choice === "hours"
          ? "day"
          : freshness.choice === "weeks"
            ? "week"
            : undefined;
    const width = difficulty.choice === "research" ? 3 : difficulty.choice === "multi_facet" ? 2 : 1;
    const { recency: _ruleRecency, ...withoutRecency } = rule;
    const plan: SearchPlan = {
      ...withoutRecency,
      mode: width > 1 ? "fanout" : "single",
      width,
      deep: difficulty.choice === "research",
      ...(recency ? { recency } : {}),
    };
    return { value: plan, confidence: difficulty.confidence };
  },

  describe: describePlan,
};
