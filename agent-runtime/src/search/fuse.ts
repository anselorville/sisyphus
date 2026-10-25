/**
 * Combines ranked lists from several providers into one.
 *
 * Reciprocal rank fusion (Cormack et al.): a hit's score is the sum over
 * providers of weight / (k + rank). It needs no comparable scores -- DeepSeek's
 * rerank score, Tavily's relevance and Brave's bare ordering live on different
 * scales -- and it rewards what several INDEPENDENT indexes agree on, which is
 * the point of asking more than one. Duplicates are merged by canonical URL.
 */

import type { SearchHit } from "./types.js";

export interface RankedList {
  readonly provider: string;
  readonly hits: readonly SearchHit[];
  /** Relative trust in this provider's ordering. */
  readonly weight?: number;
}

export interface FusedHit extends SearchHit {
  /** Every provider that returned this URL. */
  readonly agreedBy: readonly string[];
  readonly fusedScore: number;
}

const RRF_K = 60;

/**
 * Trust in each provider's own ordering, measured on 96 labelled queries (docs/web-search.md,
 * "Fusion weights"): with equal weights the fused top five scored 0.02-0.07 nDCG@5 below
 * DeepSeek alone, because DeepSeek's result ordering is far better than Tavily's or Brave's.
 * These weights remove that penalty. Agreement still lifts a page, but no single weaker
 * provider outvotes DeepSeek's first choice; two of them agreeing on another page can.
 */
export const DEFAULT_FUSION_WEIGHTS: Readonly<Record<string, number>> = { deepseek: 3, brave: 2, tavily: 1, glm: 0.5 };

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|spm$|from$|ref$|share)/i;

/** Same page, different spelling: scheme, `www.`, fragment, trailing slash and tracking parameters are ignored. */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "") || "";
    const query = url.searchParams.toString();
    return `${host}${path}${query ? `?${query}` : ""}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function fuse(lists: readonly RankedList[], limit: number): FusedHit[] {
  const merged = new Map<string, { hit: SearchHit; score: number; providers: Set<string> }>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.hits.forEach((hit, index) => {
      const key = canonicalUrl(hit.url);
      const gain = weight / (RRF_K + index + 1);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { hit, score: gain, providers: new Set([list.provider]) });
        return;
      }
      existing.score += gain;
      existing.providers.add(list.provider);
      // Keep the most informative description of the same page.
      if (hit.snippet.length > existing.hit.snippet.length) existing.hit = { ...existing.hit, snippet: hit.snippet };
      if (!existing.hit.title && hit.title) existing.hit = { ...existing.hit, title: hit.title };
      if (!existing.hit.publishedAt && hit.publishedAt) existing.hit = { ...existing.hit, publishedAt: hit.publishedAt };
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || b.providers.size - a.providers.size)
    .slice(0, limit)
    .map(({ hit, score, providers }) => ({ ...hit, agreedBy: [...providers], fusedScore: score }));
}
