import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpKeepAliveTransport, JevClient, JevError, parseResponse, type JevTransport } from "../../src/decision/jev-client.js";

const ANSWER = JSON.stringify({
  model: "jev-1.14.0",
  answers: {
    intent: { type: "choice", choice: "new_request", confidence: 0.9, probabilities: { new_request: 0.95, stop_speaking: 0.05 } },
    urgency: { type: "score", score: 1.4, confidence: 0.7, legend: { "0": "low", "1": "high" }, probabilities: { "0": 0.2, "1": 0.8 } },
    safe: { type: "noul", noul: 0.12 },
  },
  usage: { input_tokens: 500, output_tokens: 90 },
});

class FakeTransport implements JevTransport {
  readonly calls: Array<{ method: string; path: string; body?: string }> = [];
  responses: Array<{ status: number; body: string } | Error> = [];
  closed = false;
  async request(method: "GET" | "POST", path: string, body: string | undefined) {
    this.calls.push({ method, path, body });
    const next = this.responses.shift() ?? { status: 200, body: path === "/v1/models" ? "{}" : ANSWER };
    if (next instanceof Error) throw next;
    return next;
  }
  close(): void {
    this.closed = true;
  }
}

async function warmClient(transport: FakeTransport, extra: Partial<ConstructorParameters<typeof JevClient>[0]> = {}): Promise<JevClient> {
  const client = new JevClient({ transport, onWarn: () => {}, keepAliveIntervalMs: 3_600_000, ...extra });
  client.start();
  await client.whenWarm();
  return client;
}

describe("parseResponse", () => {
  it("reads choice, score and noul answers and the token usage", () => {
    const r = parseResponse(ANSWER, 42);

    expect(r.choices["intent"]).toEqual({ choice: "new_request", confidence: 0.9, probabilities: { new_request: 0.95, stop_speaking: 0.05 } });
    expect(r.scores["urgency"]?.score).toBe(1.4);
    expect(r.nouls["safe"]).toEqual({ p: 0.12 });
    expect(r).toMatchObject({ model: "jev-1.14.0", inputTokens: 500, latencyMs: 42 });
  });

  it.each([
    ["not json", "nope"],
    ["no answers", "{}"],
    ["unknown type", JSON.stringify({ answers: { a: { type: "box" } } })],
    ["probability out of range", JSON.stringify({ answers: { a: { type: "choice", choice: "x", confidence: 0.5, probabilities: { x: 1.5 } } } })],
    ["choice without confidence", JSON.stringify({ answers: { a: { type: "choice", choice: "x", probabilities: { x: 1 } } } })],
  ])("rejects %s as a shape error rather than guessing", (_name, body) => {
    expect(() => parseResponse(body, 1)).toThrowError(expect.objectContaining({ kind: "shape" }));
  });
});

describe("JevClient", () => {
  it("is disabled without a key and says so", async () => {
    const client = new JevClient({});

    expect(client.enabled).toBe(false);
    await expect(client.ask({}, {}, { timeoutMs: 100 })).rejects.toMatchObject({ kind: "disabled" });
  });

  it("refuses to spend a decision's budget on a cold connection", async () => {
    const transport = new FakeTransport();
    const client = new JevClient({ transport, onWarn: () => {} });

    await expect(client.ask({}, {}, { timeoutMs: 100 })).rejects.toMatchObject({ kind: "not_ready" });
    expect(transport.calls).toHaveLength(0);
  });

  it("warms two connections, then answers questions and accounts for usage", async () => {
    const transport = new FakeTransport();
    const client = await warmClient(transport);

    const response = await client.ask({ text: "hi" }, { intent: { type: "choice", criteria: { a: "x" } } }, { timeoutMs: 500 });

    expect(transport.calls.filter((c) => c.path === "/v1/models")).toHaveLength(2);
    expect(JSON.parse(transport.calls.at(-1)!.body!)).toMatchObject({ model: "jev-latest", state: { text: "hi" } });
    expect(response.choices["intent"]?.choice).toBe("new_request");
    expect(client.stats()).toMatchObject({ calls: 1, failures: 0, inputTokens: 500, ready: true });
    expect(client.stats().estimatedCostUsd).toBeCloseTo((500 / 1_000_000) * 0.042);
    client.stop();
  });

  it("retries warm-up after a failure instead of staying cold", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      transport.responses = [new JevError("network", "connect failed"), new JevError("network", "connect failed")];
      const client = new JevClient({ transport, onWarn: () => {}, keepAliveIntervalMs: 3_600_000 });

      client.start();
      await vi.advanceTimersByTimeAsync(2_500);
      await client.whenWarm();

      expect(client.isReady).toBe(true);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the circuit after repeated failures, then lets one probe through", async () => {
    let now = 1_000;
    const transport = new FakeTransport();
    const client = await warmClient(transport, { now: () => now, failureThreshold: 2, circuitOpenMs: 10_000 });
    transport.responses = [{ status: 500, body: "boom" }, { status: 500, body: "boom" }];

    await expect(client.ask({}, {}, { timeoutMs: 100 })).rejects.toMatchObject({ kind: "http", status: 500 });
    await expect(client.ask({}, {}, { timeoutMs: 100 })).rejects.toMatchObject({ kind: "http" });
    const callsWhenOpen = transport.calls.length;
    await expect(client.ask({}, {}, { timeoutMs: 100 })).rejects.toMatchObject({ kind: "circuit_open" });

    expect(transport.calls).toHaveLength(callsWhenOpen);
    expect(client.isReady).toBe(false);
    expect(client.stats().circuit).toBe("open");

    now += 11_000;
    await expect(client.ask({}, {}, { timeoutMs: 100 })).resolves.toBeDefined();
    expect(client.stats().circuit).toBe("closed");
    client.stop();
  });

  it("counts timeouts separately and surfaces them as errors the engine can fall back on", async () => {
    const transport = new FakeTransport();
    const client = await warmClient(transport);
    transport.responses = [new JevError("timeout", "no response within 100ms")];

    await expect(client.ask({}, {}, { timeoutMs: 100 })).rejects.toMatchObject({ kind: "timeout" });

    expect(client.stats()).toMatchObject({ failures: 1, timeouts: 1 });
    client.stop();
  });

  it("closes its connections on stop", async () => {
    const transport = new FakeTransport();
    const client = await warmClient(transport);

    client.stop();

    expect(transport.closed).toBe(true);
  });
});

describe("HttpKeepAliveTransport against a real local server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  it("sends the bearer key and body, and reuses one TCP connection across requests", async () => {
    const seen: Array<{ auth?: string; body: string }> = [];
    let connections = 0;
    const baseUrl = await listen((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ auth: req.headers.authorization, body });
        res.setHeader("content-type", "application/json");
        res.end(ANSWER);
      });
    });
    server!.on("connection", () => (connections += 1));
    const transport = new HttpKeepAliveTransport({ baseUrl, apiKey: "k-test", maxSockets: 1 });

    for (let i = 0; i < 4; i += 1) {
      const { status } = await transport.request("POST", "/v1/systemone", `{"n":${i}}`, 1_000);
      expect(status).toBe(200);
    }

    expect(connections).toBe(1);
    expect(seen.every((s) => s.auth === "Bearer k-test")).toBe(true);
    expect(seen.map((s) => s.body)).toEqual(['{"n":0}', '{"n":1}', '{"n":2}', '{"n":3}']);
    transport.close();
  });

  it("times out a server that never answers, with a timeout error", async () => {
    const baseUrl = await listen(() => {});
    const transport = new HttpKeepAliveTransport({ baseUrl, apiKey: "k" });

    await expect(transport.request("POST", "/v1/systemone", "{}", 80)).rejects.toMatchObject({ kind: "timeout" });
    transport.close();
  });

  it("returns non-200 statuses to the caller rather than throwing", async () => {
    const baseUrl = await listen((_req, res) => {
      res.statusCode = 422;
      res.end('{"detail":[]}');
    });
    const transport = new HttpKeepAliveTransport({ baseUrl, apiKey: "k" });

    await expect(transport.request("POST", "/v1/systemone", "{}", 500)).resolves.toMatchObject({ status: 422 });
    transport.close();
  });
});
