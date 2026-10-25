import { describe, expect, it, vi } from "vitest";

import { DecisionEngine, type DecisionRecord, type DecisionSpec } from "../../src/decision/decision-engine.js";
import { JevClient, JevError, type JevResponse, type JevTransport } from "../../src/decision/jev-client.js";

const ANSWER = (choice: string, p: number): string =>
  JSON.stringify({
    model: "jev-test",
    answers: { pick: { type: "choice", choice, confidence: p, probabilities: { a: choice === "a" ? p : 1 - p, b: choice === "b" ? p : 1 - p } } },
    usage: { input_tokens: 10, output_tokens: 1 },
  });

class ScriptedTransport implements JevTransport {
  next: { status: number; body: string } | Error = { status: 200, body: ANSWER("b", 0.95) };
  delayMs = 0;
  asked = 0;
  async request(_m: "GET" | "POST", path: string) {
    if (path === "/v1/models") return { status: 200, body: "{}" };
    this.asked += 1;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
  close(): void {}
}

const spec: DecisionSpec<{ text: string }, string> = {
  name: "pick",
  version: "7",
  budgetMs: 500,
  buildRequest: (input) => ({ state: { text: input.text }, questions: { pick: { type: "choice", criteria: { a: "first", b: "second" } } } }),
  interpret(response: JevResponse) {
    const pick = response.choices["pick"];
    if (!pick || (pick.probabilities[pick.choice] ?? 0) < 0.8) return undefined;
    return { value: pick.choice, confidence: pick.confidence };
  },
  describe: (value) => value,
};

async function setup(mode: "off" | "shadow" | "live") {
  const transport = new ScriptedTransport();
  const client = new JevClient({ transport, onWarn: () => {}, keepAliveIntervalMs: 3_600_000 });
  client.start();
  await client.whenWarm();
  const records: DecisionRecord[] = [];
  const engine = new DecisionEngine({ client, mode, onRecord: (r) => records.push(r) });
  return { transport, client, engine, records };
}

describe("DecisionEngine", () => {
  it("off: returns the rule's answer and never calls Jev", async () => {
    const { engine, transport, records } = await setup("off");

    expect(await engine.decide(spec, { text: "x" }, "a")).toBe("a");
    expect(transport.asked).toBe(0);
    expect(records).toEqual([]);
  });

  it("is rules-only when there is no key, whatever the mode", async () => {
    const engine = new DecisionEngine({ client: new JevClient({}), mode: "live" });

    expect(await engine.decide(spec, { text: "x" }, "a")).toBe("a");
  });

  it("shadow: returns the rule's answer immediately and logs how Jev compared", async () => {
    const { engine, transport, records } = await setup("shadow");
    transport.delayMs = 50;

    const started = Date.now();
    const value = await engine.decide(spec, { text: "x" }, "a");

    expect(value).toBe("a");
    expect(Date.now() - started).toBeLessThan(40); // did not wait for Jev
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]).toMatchObject({
      decision: "pick",
      version: "7",
      mode: "shadow",
      source: "rule",
      chosen: "a",
      baseline: "a",
      jev: "b",
      agreed: false,
    });
    expect(records[0]!.latencyMs).toBeGreaterThanOrEqual(40);
  });

  it("shadow: records agreement when Jev and the rule match", async () => {
    const { engine, records } = await setup("shadow");

    await engine.decide(spec, { text: "x" }, "b");
    await vi.waitFor(() => expect(records).toHaveLength(1));

    expect(records[0]).toMatchObject({ agreed: true, jev: "b", chosen: "b" });
  });

  it("live: uses Jev's answer when it is confident", async () => {
    const { engine, records } = await setup("live");

    expect(await engine.decide(spec, { text: "x" }, "a")).toBe("b");
    expect(records[0]).toMatchObject({ source: "jev", chosen: "b", baseline: "a", agreed: false, mode: "live" });
    expect(records[0]!.confidence).toBeDefined();
  });

  it("live: keeps the rule's answer when Jev is not confident enough", async () => {
    const { engine, transport, records } = await setup("live");
    transport.next = { status: 200, body: ANSWER("b", 0.6) };

    expect(await engine.decide(spec, { text: "x" }, "a")).toBe("a");
    expect(records[0]).toMatchObject({ source: "rule_fallback", fallbackReason: "low_confidence", chosen: "a" });
  });

  it("live: falls back to the rule on a timeout, within roughly the budget", async () => {
    const { engine, transport, records } = await setup("live");
    transport.next = new JevError("timeout", "slow");

    expect(await engine.decide(spec, { text: "x" }, "a")).toBe("a");
    expect(records[0]).toMatchObject({ source: "rule_fallback", fallbackReason: "timeout" });
  });

  it("live: falls back when the service returns an error status", async () => {
    const { engine, transport, records } = await setup("live");
    transport.next = { status: 503, body: "down" };

    expect(await engine.decide(spec, { text: "x" }, "a")).toBe("a");
    expect(records[0]).toMatchObject({ fallbackReason: "http" });
  });

  it("live: does not even try while the connection is cold", async () => {
    const transport = new ScriptedTransport();
    const client = new JevClient({ transport, onWarn: () => {} }); // never started
    const records: DecisionRecord[] = [];
    const engine = new DecisionEngine({ client, mode: "live", onRecord: (r) => records.push(r) });

    expect(await engine.decide(spec, { text: "x" }, "a")).toBe("a");
    expect(transport.asked).toBe(0);
    expect(records[0]).toMatchObject({ fallbackReason: "not_ready" });
  });

  it("a throwing audit hook never disturbs the decision", async () => {
    const transport = new ScriptedTransport();
    const client = new JevClient({ transport, onWarn: () => {} });
    client.start();
    await client.whenWarm();
    const engine = new DecisionEngine({
      client,
      mode: "live",
      onRecord: () => {
        throw new Error("audit sink down");
      },
    });

    expect(await engine.decide(spec, { text: "x" }, "a")).toBe("b");
  });

  it("the mode can be changed at runtime", async () => {
    const { engine, transport } = await setup("off");
    engine.setMode("live");

    expect(await engine.decide(spec, { text: "x" }, "a")).toBe("b");
    expect(transport.asked).toBe(1);
  });
});
