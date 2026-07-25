import { describe, expect, it } from "vitest";

import { foodState } from "../../src/economy/types.js";
import type { FoodState } from "../../src/economy/types.js";
import { ApiBudgetLedger, UnknownProviderError } from "../../src/economy/api-budget.js";

describe("foodState", () => {
  it.each<[number, FoodState]>([
    [0.31, "prosperous"],
    [0.3, "conserving"],
    [0.15, "conserving"],
    [0.149, "reserve"],
    [0.05, "reserve"],
    [0.049, "hibernating"],
  ])("maps remaining ratio %s to %s", (ratio, expected) => {
    expect(foodState(ratio)).toBe(expected);
  });
});

describe("ApiBudgetLedger", () => {
  it("never allocates voice reserve to a worker", () => {
    const budget = new ApiBudgetLedger({ dailyLimitUsd: 10, voiceReserveUsd: 1 });
    budget.record("provider", 8.9);
    expect(budget.availableFor("worker")).toBeCloseTo(0.1);
    expect(budget.availableFor("voice")).toBeCloseTo(1.1);
  });

  it("tracks spend across multiple providers independently", () => {
    const budget = new ApiBudgetLedger({ dailyLimitUsd: 10, voiceReserveUsd: 1 });
    budget.record("alpha", 3);
    budget.record("beta", 4);

    expect(budget.availableFor("worker", "alpha")).toBeCloseTo(6);
    expect(budget.availableFor("worker", "beta")).toBeCloseTo(5);
    expect(budget.availableFor("worker")).toBeCloseTo(11); // aggregate across every provider seen so far

    budget.record("alpha", 1);
    expect(budget.availableFor("worker", "alpha")).toBeCloseTo(5);
    expect(budget.availableFor("worker", "beta")).toBeCloseTo(5); // untouched by alpha's spend
  });

  it("clamps the worker balance at 0 once the ordinary balance is exhausted, never negative", () => {
    const budget = new ApiBudgetLedger({ dailyLimitUsd: 10, voiceReserveUsd: 1 });
    budget.record("provider", 50);
    expect(budget.availableFor("worker")).toBe(0);
    expect(budget.availableFor("worker", "provider")).toBe(0);
  });

  it("lets voice draw on the reserve plus whatever ordinary balance remains, clamped at the daily limit", () => {
    const budget = new ApiBudgetLedger({ dailyLimitUsd: 10, voiceReserveUsd: 1 });
    budget.record("provider", 5);
    // 4 ordinary dollars remain + the full 1-dollar reserve = 5
    expect(budget.availableFor("voice", "provider")).toBeCloseTo(5);

    budget.record("provider", 20); // cumulative spend now exceeds the whole daily limit
    expect(budget.availableFor("voice", "provider")).toBe(0);
  });

  it("reports foodState for a given provider based on its own remaining ordinary ratio", () => {
    const budget = new ApiBudgetLedger({ dailyLimitUsd: 100, voiceReserveUsd: 10 });
    // ordinary capacity = 90 for every provider below
    budget.record("fresh", 1); // 89/90 remaining ~= 98.9% -> prosperous
    budget.record("mid", 70); // 20/90 remaining ~= 22.2% -> conserving
    budget.record("low", 82); // 8/90 remaining ~= 8.9% -> reserve
    budget.record("empty", 89); // 1/90 remaining ~= 1.1% -> hibernating

    expect(budget.foodStateFor("fresh")).toBe("prosperous");
    expect(budget.foodStateFor("mid")).toBe("conserving");
    expect(budget.foodStateFor("low")).toBe("reserve");
    expect(budget.foodStateFor("empty")).toBe("hibernating");
  });

  it("throws UnknownProviderError for a provider that has never recorded any spend", () => {
    const budget = new ApiBudgetLedger({ dailyLimitUsd: 10, voiceReserveUsd: 1 });
    expect(() => budget.foodStateFor("ghost")).toThrow(UnknownProviderError);
    expect(() => budget.availableFor("worker", "ghost")).toThrow(UnknownProviderError);
  });

  it("rejects a negative or non-finite cost", () => {
    const budget = new ApiBudgetLedger({ dailyLimitUsd: 10, voiceReserveUsd: 1 });
    expect(() => budget.record("provider", -1)).toThrow(RangeError);
    expect(() => budget.record("provider", Number.NaN)).toThrow(RangeError);
  });

  it("resets a provider's spend once its daily window elapses", () => {
    let currentMs = Date.parse("2026-01-01T00:00:00.000Z");
    const budget = new ApiBudgetLedger({
      dailyLimitUsd: 10,
      voiceReserveUsd: 1,
      now: () => new Date(currentMs),
    });

    budget.record("provider", 8);
    expect(budget.availableFor("worker", "provider")).toBeCloseTo(1);

    currentMs += 25 * 60 * 60 * 1000; // 25h later, past the 24h window
    expect(budget.availableFor("worker", "provider")).toBeCloseTo(9); // back to full ordinary capacity

    budget.record("provider", 2);
    expect(budget.availableFor("worker", "provider")).toBeCloseTo(7);
  });
});
