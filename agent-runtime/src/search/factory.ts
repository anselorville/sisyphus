/**
 * Builds the search providers that have credentials. A provider without a key
 * is simply absent, so the chain adapts to whatever the deployment has
 * configured; `SEARCH_PROVIDERS=deepseek,brave` restricts it further.
 */

import { KeepAliveHttp } from "../net/keep-alive-http.js";
import { BRAVE_BASE_URL, BraveSearchProvider } from "./providers/brave.js";
import { DEEPSEEK_SEARCH_BASE_URL, DeepSeekSearchProvider } from "./providers/deepseek.js";
import { GLM_BASE_URL, GlmMcpSearchProvider } from "./providers/glm-mcp.js";
import { TAVILY_BASE_URL, TavilySearchProvider } from "./providers/tavily.js";
import type { SearchProvider } from "./types.js";

export const KNOWN_SEARCH_PROVIDERS = ["deepseek", "brave", "tavily", "glm"] as const;

export function createSearchProviders(env: Readonly<Record<string, string | undefined>>): SearchProvider[] {
  const allow = env["SEARCH_PROVIDERS"]
    ?.split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id !== "");
  const wanted = (id: string): boolean => allow === undefined || allow.length === 0 || allow.includes(id);
  const key = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const providers: SearchProvider[] = [];

  const deepseek = key("DEEPSEEK_API_KEY");
  if (deepseek && wanted("deepseek")) {
    providers.push(
      new DeepSeekSearchProvider(new KeepAliveHttp({ baseUrl: DEEPSEEK_SEARCH_BASE_URL, defaultHeaders: { authorization: `Bearer ${deepseek}` } })),
    );
  }
  const brave = key("BRAVE_SEARCH_API_KEY");
  if (brave && wanted("brave")) {
    providers.push(new BraveSearchProvider(new KeepAliveHttp({ baseUrl: BRAVE_BASE_URL, defaultHeaders: { "x-subscription-token": brave } })));
  }
  const tavily = key("TAVILY_API_KEY");
  if (tavily && wanted("tavily")) {
    providers.push(new TavilySearchProvider(new KeepAliveHttp({ baseUrl: TAVILY_BASE_URL, defaultHeaders: { authorization: `Bearer ${tavily}` } })));
  }
  const glm = key("GLM_API_KEY");
  if (glm && wanted("glm")) {
    providers.push(new GlmMcpSearchProvider(new KeepAliveHttp({ baseUrl: GLM_BASE_URL, defaultHeaders: { authorization: `Bearer ${glm}` } })));
  }
  return providers;
}
