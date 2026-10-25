/**
 * A small HTTP client that keeps its connections open, for APIs reached over a
 * route where a new TLS connection is expensive.
 *
 * Measured from this deployment: the TLS handshake to api.search.brave.com,
 * api.tavily.com and api.typesafe.ai takes ~5.5s, while the same request over
 * a connection that is already open takes 0.3-1.3s (DeepSeek, MiniMax and
 * Zhipu handshake in ~30ms, so they barely notice). A client that opens a
 * fresh connection per call turns a one second search into a six second one.
 * So each host gets its own pool of kept-alive sockets, opened early
 * (`ping()`) and kept from idling out.
 *
 * Callers depend on `HttpPort`, not on this class, so tests substitute a fake
 * and never touch the network.
 */

import * as http from "node:http";
import * as https from "node:https";

export interface HttpRequest {
  readonly method: "GET" | "POST";
  /** Path (and query) on the client's base URL. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type HttpFailureKind = "timeout" | "network";

export class HttpFailure extends Error {
  constructor(
    readonly kind: HttpFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "HttpFailure";
  }
}

export interface HttpPort {
  request(request: HttpRequest): Promise<HttpResponse>;
  /** Opens (or refreshes) a connection without caring about the answer; never throws. */
  ping(): Promise<void>;
  close(): void;
}

export interface KeepAliveHttpOptions {
  /** Origin, optionally with a path prefix (`http:` is supported so tests can use a local server). */
  readonly baseUrl: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Connections kept open per host. */
  readonly maxSockets?: number;
}

export class KeepAliveHttp implements HttpPort {
  private readonly url: URL;
  private readonly agent: http.Agent | https.Agent;
  private readonly lib: typeof http | typeof https;
  private readonly defaultHeaders: Readonly<Record<string, string>>;

  constructor(options: KeepAliveHttpOptions) {
    this.url = new URL(options.baseUrl);
    this.defaultHeaders = options.defaultHeaders ?? {};
    const sockets = options.maxSockets ?? 2;
    const agentOptions = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: sockets, maxFreeSockets: sockets };
    if (this.url.protocol === "http:") {
      this.lib = http;
      this.agent = new http.Agent(agentOptions);
    } else {
      this.lib = https;
      this.agent = new https.Agent(agentOptions);
    }
  }

  request(request: HttpRequest): Promise<HttpResponse> {
    const attempt = (retryOnStaleSocket: boolean): Promise<HttpResponse> =>
      new Promise((resolve, reject) => {
        const req = this.lib.request(
          {
            protocol: this.url.protocol,
            hostname: this.url.hostname,
            port: this.url.port || undefined,
            path: `${this.url.pathname.replace(/\/$/, "")}${request.path}`,
            method: request.method,
            agent: this.agent,
            headers: {
              ...this.defaultHeaders,
              ...request.headers,
              ...(request.body === undefined ? {} : { "content-length": String(Buffer.byteLength(request.body)) }),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const headers: Record<string, string> = {};
              for (const [name, value] of Object.entries(res.headers)) {
                if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
              }
              resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
            });
            res.on("error", (error) => reject(new HttpFailure("network", error.message)));
          },
        );
        const timer = setTimeout(() => req.destroy(new HttpFailure("timeout", `no response within ${request.timeoutMs}ms`)), request.timeoutMs);
        req.on("close", () => clearTimeout(timer));
        req.on("error", (error) => {
          if (error instanceof HttpFailure) {
            reject(error);
            return;
          }
          // A pooled socket the server already closed fails instantly; a fresh attempt is the right response.
          if (retryOnStaleSocket && req.reusedSocket && (error as NodeJS.ErrnoException).code === "ECONNRESET") {
            attempt(false).then(resolve, reject);
            return;
          }
          reject(new HttpFailure("network", error.message));
        });
        if (request.body !== undefined) req.write(request.body);
        req.end();
      });
    return attempt(true);
  }

  async ping(): Promise<void> {
    // Any completed request leaves a warm socket in the pool; the status is irrelevant.
    await this.request({ method: "GET", path: "/", timeoutMs: 15_000 }).catch(() => undefined);
  }

  close(): void {
    this.agent.destroy();
  }
}
