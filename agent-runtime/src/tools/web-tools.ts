/**
 * Web Scout's two custom tools: web_search(query) (a configurable Brave
 * Search HTTP adapter) and web_fetch(url) (a hardened HTTP GET with a
 * scheme allowlist, a response-size cap, a timeout, and a redirect cap).
 *
 * Both route through CapabilityGateway.execute() -- per capability-gateway
 * .ts's own module doc comment, "web requests" are explicitly one of the
 * external-world actions that must pass through the single choke point, not
 * just file/mail/device actions. Both are plain reads (operation: "read",
 * not reversible/sensitive/availability-threatening), so under the existing
 * DiplomacyOfficer rules they always resolve ALLOW -- this module does not
 * special-case that, it just describes the action accurately and lets the
 * officer decide (same principle as the mail adapter's bulk-vs-single-send
 * distinction).
 *
 * Fetched/searched content is external, untrusted data. Callers (the Web
 * Scout role prompt, in particular) must treat it the same way the mail
 * adapter treats email content: text to read and summarize, never an
 * instruction to follow. This module does not attempt to interpret it
 * either -- it only fetches and hands back plain strings.
 */

import type { ActionEnvelope } from "./diplomacy-officer.js";

/** Structural seam CapabilityGateway satisfies as-is (mirrors CapabilityGatewayLike in ./mail/agently-mail.ts). */
export interface CapabilityGatewayLike {
  execute<T>(envelope: ActionEnvelope, operation: () => Promise<T>): Promise<T>;
}

export interface ToolCallContext {
  readonly taskId?: string;
  readonly roleId?: string;
}

const DEFAULT_ROLE_ID = "web";
const DEFAULT_TASK_ID = "adhoc";

function readEnvelope(toolName: string, targetSummary: string, context: ToolCallContext | undefined): ActionEnvelope {
  return {
    taskId: context?.taskId ?? DEFAULT_TASK_ID,
    roleId: context?.roleId ?? DEFAULT_ROLE_ID,
    toolName,
    targetSummary,
    reversible: true,
    affectedObjects: 1,
    externalAudience: 0,
    sensitiveData: false,
    threatensAvailability: false,
    operation: "read",
  };
}

// ---------------------------------------------------------------------------
// web_search: configurable Brave Search HTTP adapter.
// ---------------------------------------------------------------------------

/** Matches fetch's own signature so a real `fetch` or a test fake are interchangeable. */
export type FetchLike = typeof fetch;

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebSearchRequestOptions {
  readonly count?: number;
}

export interface BraveSearchConfig {
  /** Default: Brave's public Web Search API endpoint. Configurable so tests/self-hosted proxies never need to hardcode Brave's real URL. */
  readonly endpoint?: string;
  /** Explicit key, mainly for tests. Production should prefer apiKeyEnvVar so no real key is ever hardcoded in source. */
  readonly apiKey?: string;
  /** Name of the environment variable holding the API key. Default: BRAVE_SEARCH_API_KEY. */
  readonly apiKeyEnvVar?: string;
}

const DEFAULT_BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_BRAVE_API_KEY_ENV = "BRAVE_SEARCH_API_KEY";

/** Thrown when web_search is called but no API key is configured (neither an explicit apiKey nor the configured environment variable is set). */
export class BraveSearchConfigError extends Error {
  constructor(envVar: string) {
    super(`Brave Search API key is not configured (set options.apiKey or the ${envVar} environment variable)`);
    this.name = "BraveSearchConfigError";
  }
}

interface BraveSearchResponsePayload {
  readonly web?: {
    readonly results?: ReadonlyArray<{
      readonly title?: string;
      readonly url?: string;
      readonly description?: string;
    }>;
  };
}

export interface WebToolsOptions {
  readonly gateway: CapabilityGatewayLike;
  readonly fetchImpl?: FetchLike;
  readonly brave?: BraveSearchConfig;
  readonly webFetch?: WebFetchOptions;
}

// ---------------------------------------------------------------------------
// web_fetch: hardened HTTP GET.
// ---------------------------------------------------------------------------

export interface WebFetchOptions {
  /** Default 2 MiB. */
  readonly maxBytes?: number;
  /** Default 15 000 ms. */
  readonly timeoutMs?: number;
  /** Default 5. */
  readonly maxRedirects?: number;
}

export interface WebFetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: string;
  /** True if the response body was cut off at maxBytes. */
  readonly truncated: boolean;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class InvalidUrlSchemeError extends Error {
  constructor(url: string) {
    super(`web_fetch only accepts http/https URLs, got: ${url}`);
    this.name = "InvalidUrlSchemeError";
  }
}

export class WebFetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`web_fetch timed out after ${timeoutMs}ms fetching ${url}`);
    this.name = "WebFetchTimeoutError";
  }
}

export class TooManyRedirectsError extends Error {
  constructor(url: string, maxRedirects: number) {
    super(`web_fetch exceeded ${maxRedirects} redirect(s) starting from ${url}`);
    this.name = "TooManyRedirectsError";
  }
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidUrlSchemeError(url);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidUrlSchemeError(url);
  }
}

/** Reads a response body up to `maxBytes`, cutting off (and reporting `truncated: true`) rather than throwing once the cap is reached. */
async function readBodyCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const overflow = Buffer.byteLength(text, "utf8") > maxBytes;
    return overflow ? { text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true } : { text, truncated: false };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }
    const chunk = Buffer.from(value);
    if (total + chunk.byteLength > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - total));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }

  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/**
 * Web Scout's tool surface. Both methods route through CapabilityGateway
 * (see the module doc comment); the actual HTTP work is a private detail
 * each method's `operation` closure performs.
 */
export class WebTools {
  private readonly gateway: CapabilityGatewayLike;
  private readonly fetchImpl: FetchLike;
  private readonly braveEndpoint: string;
  private readonly braveApiKey: string | undefined;
  private readonly braveApiKeyEnvVar: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  constructor(options: WebToolsOptions) {
    this.gateway = options.gateway;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.braveEndpoint = options.brave?.endpoint ?? DEFAULT_BRAVE_ENDPOINT;
    this.braveApiKeyEnvVar = options.brave?.apiKeyEnvVar ?? DEFAULT_BRAVE_API_KEY_ENV;
    this.braveApiKey = options.brave?.apiKey ?? process.env[this.braveApiKeyEnvVar];
    this.maxBytes = options.webFetch?.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.webFetch?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.webFetch?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  async web_search(query: string, options: WebSearchRequestOptions = {}, context?: ToolCallContext): Promise<readonly WebSearchResult[]> {
    if (query.trim() === "") {
      throw new RangeError("web_search query must not be empty");
    }
    const envelope = readEnvelope("web_search", `search "${query}"`, context);
    return this.gateway.execute(envelope, () => this.performSearch(query, options));
  }

  async web_fetch(url: string, context?: ToolCallContext): Promise<WebFetchResult> {
    assertHttpUrl(url);
    const envelope = readEnvelope("web_fetch", url, context);
    return this.gateway.execute(envelope, () => this.performFetch(url));
  }

  private async performSearch(query: string, options: WebSearchRequestOptions): Promise<readonly WebSearchResult[]> {
    if (!this.braveApiKey) {
      throw new BraveSearchConfigError(this.braveApiKeyEnvVar);
    }

    const url = new URL(this.braveEndpoint);
    url.searchParams.set("q", query);
    if (options.count !== undefined) {
      url.searchParams.set("count", String(options.count));
    }

    const response = await this.fetchImpl(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": this.braveApiKey },
    });
    if (!response.ok) {
      throw new Error(`Brave Search request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as BraveSearchResponsePayload;
    return (payload.web?.results ?? []).map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      snippet: result.description ?? "",
    }));
  }

  private async performFetch(url: string): Promise<WebFetchResult> {
    let currentUrl = url;

    for (let redirectCount = 0; ; redirectCount++) {
      assertHttpUrl(currentUrl);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(currentUrl, { redirect: "manual", signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new WebFetchTimeoutError(url, this.timeoutMs);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirectCount >= this.maxRedirects) {
          throw new TooManyRedirectsError(url, this.maxRedirects);
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`web_fetch received a redirect with no Location header from ${currentUrl}`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      const { text, truncated } = await readBodyCapped(response, this.maxBytes);
      return {
        url: currentUrl,
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        body: text,
        truncated,
      };
    }
  }
}
