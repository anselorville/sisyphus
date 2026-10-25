/**
 * SearchRouter: one `web_search` over several independent search providers.
 *
 *   single  -- ask the best healthy provider; if it fails or finds nothing,
 *              walk down the chain until one answers (the common case).
 *   fanout  -- for hard or time-sensitive questions ask several providers at
 *              once, take the first answer plus a short grace window for the
 *              others, and fuse the lists (./fuse.ts): pages that independent
 *              indexes both return rank higher.
 *
 * Which mode, and with what freshness, comes from the plan (./planner.ts): a
 * deterministic rule plan, optionally refined by Jev in parallel with the first
 * provider call so the refinement adds no latency. Health (./health.ts) keeps
 * providers that are out of quota, rate limited or timing out off the path
 * until they can answer again; providers in the same preference tier are
 * rotated so load and free-tier quotas spread evenly.
 *
 * It never returns an empty list silently: if every provider failed the error
 * says why each one did, and a search that found nothing says so.
 */

import { SearchHealth, type ProviderHealthSnapshot } from "./health.js";
import { fuse, type FusedHit, type RankedList } from "./fuse.js";
import { planByRules, type SearchPlan, type SearchPlanInput } from "./planner.js";
import { SearchError, type SearchHit, type SearchProvider, type SearchRequest } from "./types.js";

export interface SearchAttempt {
  readonly provider: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly hits: number;
  readonly error?: string;
}

export interface SearchTrace {
  readonly query: string;
  /** The plan that was used (rule plan, possibly refined). */
  readonly plan: string;
  readonly refined: boolean;
  readonly attempts: readonly SearchAttempt[];
  /** Providers whose results are in the answer. */
  readonly contributors: readonly string[];
  readonly totalMs: number;
}

export interface SearchOutcome {
  readonly hits: readonly FusedHit[];
  readonly trace: SearchTrace;
}

export class SearchUnavailableError extends Error {
  constructor(
    readonly attempts: readonly SearchAttempt[],
    reason: string,
  ) {
    super(reason);
    this.name = "SearchUnavailableError";
  }
}

export interface SearchRouterOptions {
  readonly providers: readonly SearchProvider[];
  readonly health?: SearchHealth;
  /** Jev (or any other) refinement of the rule plan; must resolve quickly or reject. */
  readonly refine?: (input: SearchPlanInput) => Promise<SearchPlan>;
  readonly now?: () => number;
  readonly perProviderTimeoutMs?: number;
  readonly totalDeadlineMs?: number;
  /** After the first fan-out answer, how long to wait for the others. */
  readonly fanoutGraceMs?: number;
  readonly keepAliveIntervalMs?: number;
  /** Trust in each provider's ordering when fusing; default 1. */
  readonly weights?: Readonly<Record<string, number>>;
  readonly onSearch?: (trace: SearchTrace) => void;
}

interface AttemptResult {
  readonly provider: string;
  readonly hits: SearchHit[];
  readonly attempt: SearchAttempt;
}

const DEFAULT_PER_PROVIDER_MS = 4_000;
const DEFAULT_DEADLINE_MS = 8_000;
const DEFAULT_GRACE_MS = 700;
/** Ask for a little more than needed so fusion has something to choose between. */
const OVERFETCH = 2;

export class SearchRouter {
  readonly health: SearchHealth;
  private readonly providers: ReadonlyMap<string, SearchProvider>;
  private readonly now: () => number;
  private readonly perProviderMs: number;
  private readonly deadlineMs: number;
  private readonly graceMs: number;
  private readonly keepAliveMs: number;
  private readonly rotation = new Map<string, number>();
  private readonly ready = new Set<string>();
  private warming: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: SearchRouterOptions) {
    this.providers = new Map(options.providers.map((p) => [p.id, p]));
    this.now = options.now ?? ((): number => Date.now());
    this.health = options.health ?? new SearchHealth({ now: this.now });
    this.perProviderMs = options.perProviderTimeoutMs ?? DEFAULT_PER_PROVIDER_MS;
    this.deadlineMs = options.totalDeadlineMs ?? DEFAULT_DEADLINE_MS;
    this.graceMs = options.fanoutGraceMs ?? DEFAULT_GRACE_MS;
    this.keepAliveMs = options.keepAliveIntervalMs ?? 15_000;
  }

  get providerIds(): string[] {
    return [...this.providers.keys()];
  }

  /** Opens every provider's connection in the background and keeps them warm. Returns at once. */
  start(): void {
    if (this.timer) return;
    const warmAll = (): Promise<void> =>
      Promise.all([...this.providers.values()].map((provider) => provider.warm().then(() => void this.ready.add(provider.id)))).then(() => undefined);
    this.warming = warmAll();
    this.timer = setInterval(() => void warmAll(), this.keepAliveMs);
    this.timer.unref();
  }

  /** Resolves once the first warm-up of every provider has finished. */
  async whenWarm(): Promise<void> {
    await this.warming;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const provider of this.providers.values()) provider.close();
  }

  healthSnapshot(): ProviderHealthSnapshot[] {
    return this.health.snapshot(this.providerIds);
  }

  async search(query: string, options: { readonly count?: number } = {}): Promise<SearchOutcome> {
    const started = this.now();
    const count = Math.min(Math.max(options.count ?? 5, 1), 20);
    const rule = planByRules(query);
    const ordered = this.order(rule);
    const attempts: SearchAttempt[] = [];
    const lists: RankedList[] = [];
    const tried = new Set<string>();
    const deadline = started + this.deadlineMs;
    const ask = (id: string, plan: SearchPlan): Promise<AttemptResult> => {
      tried.add(id);
      return this.attempt(id, { query, count: count * OVERFETCH, recency: plan.recency, topic: plan.topic, deep: plan.deep }, deadline);
    };
    const absorb = (results: readonly AttemptResult[]): void => {
      for (const r of results) {
        attempts.push(r.attempt);
        if (r.hits.length > 0) lists.push({ provider: r.provider, hits: r.hits, weight: this.options.weights?.[r.provider] });
      }
    };

    // Wave 1: the rule plan's first providers, with the Jev refinement racing alongside.
    const firstWave = ordered.slice(0, rule.width).map((id) => ask(id, rule));
    const refining = this.options.refine ? this.options.refine({ query, rule }).catch(() => rule) : Promise.resolve(rule);
    const [firstResults, plan] = await Promise.all([this.collect(firstWave, rule.width > 1), refining]);
    absorb(firstResults);

    // The refinement may call for more breadth than the rule plan did.
    if (plan.width > firstWave.length) {
      const extra = ordered.filter((id) => !tried.has(id)).slice(0, plan.width - firstWave.length);
      if (extra.length > 0) absorb(await this.collect(extra.map((id) => ask(id, plan)), true));
    }

    // Nothing yet: walk down the chain, one provider at a time, until something answers.
    for (const id of ordered) {
      if (lists.length > 0 || this.now() >= deadline) break;
      if (tried.has(id)) continue;
      absorb(await this.collect([ask(id, plan)], false));
    }

    const trace: SearchTrace = {
      query,
      plan: describe(plan),
      refined: describe(plan) !== describe(rule),
      attempts,
      contributors: lists.map((l) => l.provider),
      totalMs: this.now() - started,
    };
    this.options.onSearch?.(trace);

    if (lists.length === 0) {
      const failures = attempts.filter((a) => !a.ok);
      if (failures.length === 0 && attempts.length > 0) {
        return { hits: [], trace };
      }
      const why = attempts.length === 0 ? "no search provider is available" : failures.map((a) => `${a.provider} (${a.error})`).join("; ");
      throw new SearchUnavailableError(attempts, `all search providers failed: ${why}`);
    }
    const hits = lists.length === 1 ? singleList(lists[0] as RankedList, count) : fuse(lists, count);
    return { hits, trace };
  }

  /**
   * Healthy providers in preference order. Within a tier the starting point
   * rotates call by call; providers that are slow to reach cold and are not
   * warm yet go last (a cold connection costs ~5s here), but are not excluded.
   */
  private order(plan: SearchPlan): string[] {
    const ordered: string[] = [];
    for (const tier of plan.tiers) {
      const live = this.health.available(tier.filter((id) => this.providers.has(id)));
      if (live.length > 1) {
        const key = tier.join("|");
        const turn = this.rotation.get(key) ?? 0;
        this.rotation.set(key, turn + 1);
        const offset = turn % live.length;
        ordered.push(...live.slice(offset), ...live.slice(0, offset));
      } else {
        ordered.push(...live);
      }
    }
    // Providers the plan does not mention are still better than failing outright.
    for (const id of this.health.available([...this.providers.keys()])) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    // Only a provider that is expensive to reach cold waits behind the others; the rest are fine at any time.
    const coldAndSlow = (id: string): boolean => this.providers.get(id)?.slowCold === true && !this.ready.has(id);
    return [...ordered.filter((id) => !coldAndSlow(id)), ...ordered.filter(coldAndSlow)];
  }

  /** Waits for one wave. With `fanout`, returns shortly after the first non-empty answer instead of waiting for the slowest. */
  private async collect(wave: readonly Promise<AttemptResult>[], fanout: boolean): Promise<AttemptResult[]> {
    if (!fanout || wave.length <= 1) return Promise.all(wave);
    const settled: AttemptResult[] = [];
    let firstGood: number | undefined;
    await new Promise<void>((resolve) => {
      let pending = wave.length;
      const finish = (): void => resolve();
      for (const promise of wave) {
        void promise.then((result) => {
          settled.push(result);
          pending -= 1;
          if (pending === 0) finish();
          if (result.hits.length > 0 && firstGood === undefined) {
            firstGood = this.now();
            setTimeout(finish, this.graceMs);
          }
        });
      }
    });
    return [...settled];
  }

  private async attempt(id: string, request: SearchRequest, deadline: number): Promise<AttemptResult> {
    const provider = this.providers.get(id) as SearchProvider;
    const started = this.now();
    const timeoutMs = Math.max(250, Math.min(this.perProviderMs, deadline - started));
    try {
      const hits = await provider.search(request, timeoutMs);
      const ms = this.now() - started;
      this.health.recordSuccess(id, ms);
      return { provider: id, hits, attempt: { provider: id, ok: true, ms, hits: hits.length } };
    } catch (error) {
      const ms = this.now() - started;
      const failure = error instanceof SearchError ? error : new SearchError(id, "network", error instanceof Error ? error.message : String(error));
      this.health.recordFailure(id, failure);
      return { provider: id, hits: [], attempt: { provider: id, ok: false, ms, hits: 0, error: `${failure.kind}: ${failure.message.replace(`${id}: `, "").slice(0, 120)}` } };
    }
  }
}

function describe(plan: SearchPlan): string {
  return `${plan.mode}/${plan.width}/${plan.recency ?? "-"}/${plan.topic}${plan.deep ? "/deep" : ""}`;
}

function singleList(list: RankedList, count: number): FusedHit[] {
  return list.hits.slice(0, count).map((hit, index) => ({ ...hit, agreedBy: [list.provider], fusedScore: 1 / (60 + index + 1) }));
}
