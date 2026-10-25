/**
 * Client for TypeSafe's Jev, a "System One" model: it is given a state and a
 * set of typed questions and returns typed answers with probabilities -- no
 * generated text. See https://docs.typesafe.ai/api.
 *
 * This is the transport and safety layer only. What to ask and what to do
 * with the answers lives in ./decision-engine.ts and the decision specs.
 *
 * Operational facts this client is built around (measured, not assumed):
 *
 * - From this deployment the TLS handshake to api.typesafe.ai takes ~5s,
 *   while a request over an already-open connection takes ~0.3s. A cold
 *   connection per call would make every decision unusable on the voice hot
 *   path, so the client keeps connections alive, opens them at startup
 *   (`start()`), and pings them on a timer so they are never idle long
 *   enough for the server to close them.
 * - Decisions are optional accelerators over deterministic rules, so every
 *   call carries a hard time budget and failures never propagate as
 *   exceptions the caller must handle: the engine falls back to its rule.
 *   A circuit breaker stops hammering the service after repeated failures.
 * - Typed output guarantees the answer's shape, not its truth. A low
 *   `confidence` / a probability near 0.5 is information the caller must act
 *   on; this client never hides it.
 */

import * as http from "node:http";
import * as https from "node:https";

export type JevQuestion =
  | { readonly type: "choice"; readonly instructions?: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "score"; readonly instructions?: string; readonly criteria: readonly string[] }
  | { readonly type: "noul"; readonly instructions?: string; readonly criteria?: { readonly true?: string; readonly false?: string } };

export interface JevChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface JevScoreAnswer {
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface JevNoulAnswer {
  /** Probability that the statement is true (0-1). Near 0.5 means unsure, not "medium". */
  readonly p: number;
}

export interface JevResponse {
  /** The concrete model that answered (an alias such as `jev-latest` resolves to a version). */
  readonly model: string;
  readonly choices: Readonly<Record<string, JevChoiceAnswer>>;
  readonly scores: Readonly<Record<string, JevScoreAnswer>>;
  readonly nouls: Readonly<Record<string, JevNoulAnswer>>;
  readonly inputTokens: number;
  readonly latencyMs: number;
}

export type JevErrorKind = "disabled" | "not_ready" | "circuit_open" | "timeout" | "network" | "http" | "shape";

export class JevError extends Error {
  constructor(
    readonly kind: JevErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JevError";
  }
}

/** Minimal request seam so tests never touch the network. */
export interface JevTransport {
  request(method: "GET" | "POST", path: string, body: string | undefined, timeoutMs: number): Promise<{ status: number; body: string }>;
  close(): void;
}

export interface HttpKeepAliveTransportOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Connections kept open. Parallel requests beyond this wait for a free one instead of paying a new multi-second handshake. */
  readonly maxSockets?: number;
}

/** node:http(s) transport with a keep-alive agent; `http:` base URLs exist so tests can run a local server. */
export class HttpKeepAliveTransport implements JevTransport {
  private readonly url: URL;
  private readonly agent: http.Agent | https.Agent;
  private readonly lib: typeof http | typeof https;

  constructor(private readonly options: HttpKeepAliveTransportOptions) {
    this.url = new URL(options.baseUrl);
    const agentOptions = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: options.maxSockets ?? 2, maxFreeSockets: options.maxSockets ?? 2 };
    if (this.url.protocol === "http:") {
      this.lib = http;
      this.agent = new http.Agent(agentOptions);
    } else {
      this.lib = https;
      this.agent = new https.Agent(agentOptions);
    }
  }

  request(method: "GET" | "POST", path: string, body: string | undefined, timeoutMs: number): Promise<{ status: number; body: string }> {
    const attempt = (retryOnStaleSocket: boolean): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = this.lib.request(
          {
            protocol: this.url.protocol,
            hostname: this.url.hostname,
            port: this.url.port || undefined,
            path: `${this.url.pathname.replace(/\/$/, "")}${path}`,
            method,
            agent: this.agent,
            headers: {
              authorization: `Bearer ${this.options.apiKey}`,
              ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", (error) => reject(new JevError("network", error.message)));
          },
        );
        const timer = setTimeout(() => req.destroy(new JevError("timeout", `no response within ${timeoutMs}ms`)), timeoutMs);
        req.on("close", () => clearTimeout(timer));
        req.on("error", (error) => {
          if (error instanceof JevError) {
            reject(error);
            return;
          }
          // A pooled socket the server already closed fails instantly; a fresh attempt is the right response.
          if (retryOnStaleSocket && req.reusedSocket && (error as NodeJS.ErrnoException).code === "ECONNRESET") {
            attempt(false).then(resolve, reject);
            return;
          }
          reject(new JevError("network", error.message));
        });
        if (body !== undefined) req.write(body);
        req.end();
      });
    return attempt(true);
  }

  close(): void {
    this.agent.destroy();
  }
}

export interface JevClientOptions {
  /** Without a key the client is `disabled`: every call fails fast with kind "disabled". */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Model name or alias; GET /v1/models lists them. */
  readonly model?: string;
  readonly transport?: JevTransport;
  /** Consecutive failures that open the circuit. */
  readonly failureThreshold?: number;
  /** How long the circuit stays open before one probe call is allowed. */
  readonly circuitOpenMs?: number;
  readonly keepAliveIntervalMs?: number;
  readonly now?: () => number;
  /** Price per million input tokens, for the running cost estimate. */
  readonly pricePerMillionInputTokens?: number;
  readonly onWarn?: (message: string) => void;
}

export interface JevStats {
  readonly calls: number;
  readonly failures: number;
  readonly timeouts: number;
  readonly inputTokens: number;
  readonly estimatedCostUsd: number;
  readonly p50Ms: number | undefined;
  readonly p95Ms: number | undefined;
  readonly circuit: "closed" | "open";
  readonly ready: boolean;
}

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const LATENCY_WINDOW = 200;

export class JevClient {
  private readonly model: string;
  private readonly transport: JevTransport | undefined;
  private readonly failureThreshold: number;
  private readonly circuitOpenMs: number;
  private readonly keepAliveIntervalMs: number;
  private readonly now: () => number;
  private readonly price: number;
  private readonly onWarn: (message: string) => void;

  private ready = false;
  private consecutiveFailures = 0;
  private openedAt: number | undefined;
  private calls = 0;
  private failures = 0;
  private timeouts = 0;
  private inputTokens = 0;
  private readonly latencies: number[] = [];
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private warming: Promise<void> | undefined;
  private stopped = false;

  constructor(options: JevClientOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    const apiKey = options.apiKey?.trim();
    this.transport =
      options.transport ?? (apiKey ? new HttpKeepAliveTransport({ baseUrl: options.baseUrl ?? DEFAULT_BASE_URL, apiKey }) : undefined);
    this.failureThreshold = options.failureThreshold ?? 3;
    this.circuitOpenMs = options.circuitOpenMs ?? 30_000;
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? 15_000;
    this.now = options.now ?? ((): number => Date.now());
    this.price = options.pricePerMillionInputTokens ?? 0.042;
    this.onWarn = options.onWarn ?? ((message) => console.warn(`[jev] ${message}`));
  }

  /** True when a key (or injected transport) exists. */
  get enabled(): boolean {
    return this.transport !== undefined;
  }

  /** True once the connection is warm; decisions wait for this rather than burning their budget on a cold handshake. */
  get isReady(): boolean {
    return this.ready && !this.circuitIsOpen();
  }

  /**
   * Opens the connection(s) in the background and keeps them warm. Returns
   * immediately; readiness flips when the first probe succeeds. Safe to call
   * on a deployment with no key (does nothing).
   */
  start(): void {
    if (!this.transport || this.warming || this.stopped) return;
    this.warming = this.warmUp();
    this.keepAlive = setInterval(() => void this.ping(), this.keepAliveIntervalMs);
    this.keepAlive.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = undefined;
    this.transport?.close();
  }

  /** Resolves when the first warm-up attempt has finished (success or not). For tests and startup logging. */
  async whenWarm(): Promise<void> {
    await this.warming;
  }

  async ask(
    state: unknown,
    questions: Readonly<Record<string, JevQuestion>>,
    options: { readonly timeoutMs: number },
  ): Promise<JevResponse> {
    const transport = this.requireTransport();
    if (!this.ready) throw new JevError("not_ready", "connection is not warm yet");
    this.checkCircuit();

    const started = this.now();
    this.calls += 1;
    try {
      const { status, body } = await transport.request(
        "POST",
        "/v1/systemone",
        JSON.stringify({ model: this.model, state, questions }),
        options.timeoutMs,
      );
      if (status !== 200) throw new JevError("http", `HTTP ${status}: ${body.slice(0, 200)}`, status);
      const response = parseResponse(body, this.now() - started);
      this.inputTokens += response.inputTokens;
      this.recordLatency(response.latencyMs);
      this.consecutiveFailures = 0;
      return response;
    } catch (error) {
      const jevError = error instanceof JevError ? error : new JevError("network", error instanceof Error ? error.message : String(error));
      this.noteFailure(jevError);
      throw jevError;
    }
  }

  stats(): JevStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (q: number): number | undefined => (sorted.length === 0 ? undefined : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
    return {
      calls: this.calls,
      failures: this.failures,
      timeouts: this.timeouts,
      inputTokens: this.inputTokens,
      estimatedCostUsd: (this.inputTokens / 1_000_000) * this.price,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      circuit: this.circuitIsOpen() ? "open" : "closed",
      ready: this.ready,
    };
  }

  private requireTransport(): JevTransport {
    if (!this.transport) throw new JevError("disabled", "no TYPESAFE_API_KEY configured");
    return this.transport;
  }

  private circuitIsOpen(): boolean {
    return this.openedAt !== undefined && this.now() - this.openedAt < this.circuitOpenMs;
  }

  private checkCircuit(): void {
    if (this.openedAt === undefined) return;
    if (this.circuitIsOpen()) throw new JevError("circuit_open", "too many recent failures; using rules");
    // Half-open: let this one call through as the probe.
    this.openedAt = undefined;
    this.consecutiveFailures = this.failureThreshold - 1;
  }

  private noteFailure(error: JevError): void {
    this.failures += 1;
    if (error.kind === "timeout") this.timeouts += 1;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold && this.openedAt === undefined) {
      this.openedAt = this.now();
      this.onWarn(`circuit opened after ${this.consecutiveFailures} consecutive failures (last: ${error.kind}: ${error.message})`);
    }
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  private async warmUp(): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    const delays = [0, 2_000, 5_000, 15_000, 30_000];
    for (const delay of delays) {
      if (this.stopped) return;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        // Two concurrent probes open two pooled connections; the handshake is the slow part (~5s here).
        const results = await Promise.all([0, 1].map(() => transport.request("GET", "/v1/models", undefined, 20_000)));
        if (results.every((r) => r.status === 200)) {
          this.ready = true;
          return;
        }
        this.onWarn(`warm-up got HTTP ${results.map((r) => r.status).join("/")}`);
      } catch (error) {
        this.onWarn(`warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Keeps pooled connections from idling out, and recovers readiness if warm-up never succeeded. */
  private async ping(): Promise<void> {
    const transport = this.transport;
    if (!transport || this.stopped) return;
    if (!this.ready) {
      this.warming = this.warmUp();
      return;
    }
    await Promise.all([0, 1].map(() => transport.request("GET", "/v1/models", undefined, 10_000).catch(() => undefined)));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberIn01(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function probabilityMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, p] of Object.entries(value)) {
    const n = numberIn01(p);
    if (n === undefined) return undefined;
    out[key] = n;
  }
  return out;
}

/** Strictly validates the documented response shape; anything else is a "shape" error, never a guess. */
export function parseResponse(body: string, latencyMs: number): JevResponse {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new JevError("shape", "response is not JSON");
  }
  if (!isRecord(json) || !isRecord(json["answers"])) throw new JevError("shape", "response has no answers");
  const choices: Record<string, JevChoiceAnswer> = {};
  const scores: Record<string, JevScoreAnswer> = {};
  const nouls: Record<string, JevNoulAnswer> = {};
  for (const [name, answer] of Object.entries(json["answers"])) {
    if (!isRecord(answer)) throw new JevError("shape", `answer "${name}" is not an object`);
    const probabilities = probabilityMap(answer["probabilities"]);
    const confidence = numberIn01(answer["confidence"]);
    if (answer["type"] === "choice") {
      if (typeof answer["choice"] !== "string" || !probabilities || confidence === undefined) {
        throw new JevError("shape", `choice answer "${name}" is malformed`);
      }
      choices[name] = { choice: answer["choice"], confidence, probabilities };
    } else if (answer["type"] === "score") {
      if (typeof answer["score"] !== "number" || !probabilities || confidence === undefined) {
        throw new JevError("shape", `score answer "${name}" is malformed`);
      }
      scores[name] = { score: answer["score"], confidence, probabilities };
    } else if (answer["type"] === "noul") {
      const p = numberIn01(answer["noul"]);
      if (p === undefined) throw new JevError("shape", `noul answer "${name}" is malformed`);
      nouls[name] = { p };
    } else {
      throw new JevError("shape", `answer "${name}" has unsupported type`);
    }
  }
  const usage = isRecord(json["usage"]) ? json["usage"] : {};
  return {
    model: typeof json["model"] === "string" ? json["model"] : "unknown",
    choices,
    scores,
    nouls,
    inputTokens: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0,
    latencyMs,
  };
}
