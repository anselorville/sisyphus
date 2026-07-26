import { describe, expect, it } from "vitest";

import { HttpQuotaProbe } from "../../src/economy/subscription-quota.js";
import type { FetchLike, HttpQuotaProbeConfig } from "../../src/economy/subscription-quota.js";

const config: HttpQuotaProbeConfig = {
  providerId: "coding-plan-a",
  url: "https://provider.example/usage",
  authEnv: "CODING_PLAN_A_TOKEN",
  remainingJsonPointer: "/limits/five_hour/remaining_percent",
  resetAtJsonPointer: "/limits/five_hour/reset_at",
};

function fakeUsageResponse(remainingPercent: number, resetAt: string): Response {
  return new Response(
    JSON.stringify({ limits: { five_hour: { remaining_percent: remainingPercent, reset_at: resetAt } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("HttpQuotaProbe.refresh", () => {
  it("normalizes remaining_percent and reset_at via JSON-pointer lookup", async () => {
    const fetchImpl: FetchLike = (async () => fakeUsageResponse(62, "2026-07-25T20:00:00.000Z")) as FetchLike;

    const probe = new HttpQuotaProbe({ config, fetchImpl });
    const snapshot = await probe.refresh();

    expect(snapshot.providerId).toBe("coding-plan-a");
    expect(snapshot.remainingRatio).toBeCloseTo(0.62);
    expect(snapshot.resetAt).toBe("2026-07-25T20:00:00.000Z");
    expect(snapshot.foodState).toBe("prosperous");
    expect(snapshot.degraded).toBe(false);
  });

  it("reads the auth token from process.env[authEnv] as a bearer header", async () => {
    const originalEnv = process.env["CODING_PLAN_A_TOKEN"];
    process.env["CODING_PLAN_A_TOKEN"] = "secret-token";
    try {
      let capturedAuth: string | undefined;
      const fetchImpl: FetchLike = (async (_url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        capturedAuth = headers?.["Authorization"];
        return fakeUsageResponse(50, "2026-07-25T20:00:00.000Z");
      }) as FetchLike;

      const probe = new HttpQuotaProbe({ config, fetchImpl });
      await probe.refresh();

      expect(capturedAuth).toBe("Bearer secret-token");
    } finally {
      if (originalEnv !== undefined) {
        process.env["CODING_PLAN_A_TOKEN"] = originalEnv;
      } else {
        delete process.env["CODING_PLAN_A_TOKEN"];
      }
    }
  });

  it("serves the cached reading within the TTL without re-fetching", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (async () => {
      calls += 1;
      return fakeUsageResponse(80, "2026-07-25T20:00:00.000Z");
    }) as FetchLike;

    let currentMs = Date.parse("2026-07-25T10:00:00.000Z");
    const probe = new HttpQuotaProbe({ config, fetchImpl, ttlMs: 60_000, now: () => new Date(currentMs) });

    await probe.refresh();
    currentMs += 30_000; // still inside the 60s TTL
    await probe.refresh();

    expect(calls).toBe(1);
  });

  it("degrades to the conservative fallback once stale rather than serving the last-known-good value", async () => {
    let call = 0;
    const fetchImpl: FetchLike = (async () => {
      call += 1;
      if (call === 1) {
        return fakeUsageResponse(90, "2026-07-25T20:00:00.000Z");
      }
      throw new Error("network unreachable");
    }) as FetchLike;

    let currentMs = Date.parse("2026-07-25T10:00:00.000Z");
    const probe = new HttpQuotaProbe({ config, fetchImpl, ttlMs: 1_000, now: () => new Date(currentMs) });

    const first = await probe.refresh();
    expect(first.remainingRatio).toBeCloseTo(0.9);
    expect(first.degraded).toBe(false);

    currentMs += 2_000; // past the 1s TTL
    const second = await probe.refresh();

    expect(second.remainingRatio).toBe(0);
    expect(second.foodState).toBe("hibernating");
    expect(second.degraded).toBe(true);
    expect(second.ordinaryAccessAllowed).toBe(false);
  });

  it("fails safe (resolves, never rejects) when the fetch throws", async () => {
    const fetchImpl: FetchLike = (async () => {
      throw new Error("DNS failure");
    }) as FetchLike;
    const probe = new HttpQuotaProbe({ config, fetchImpl });

    const snapshot = await probe.refresh();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.remainingRatio).toBe(0);
    expect(snapshot.foodState).toBe("hibernating");
  });

  it("fails safe when the HTTP response is a non-ok status", async () => {
    const fetchImpl: FetchLike = (async () => new Response("nope", { status: 500 })) as FetchLike;
    const probe = new HttpQuotaProbe({ config, fetchImpl });

    const snapshot = await probe.refresh();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.remainingRatio).toBe(0);
  });

  it("fails safe when the configured JSON pointers don't resolve to usable values", async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response(JSON.stringify({ unrelated: true }), { status: 200 })) as FetchLike;
    const probe = new HttpQuotaProbe({ config, fetchImpl });

    const snapshot = await probe.refresh();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.remainingRatio).toBe(0);
  });
});
