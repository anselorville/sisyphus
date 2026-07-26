import { describe, expect, it } from "vitest";

import { ProviderRouter } from "../../src/economy/provider-router.js";
import type { ProviderCandidate, TaskProfile } from "../../src/economy/provider-router.js";

function provider(overrides: Partial<ProviderCandidate> & { providerId: string }): ProviderCandidate {
  return {
    capabilities: [],
    modelTier: "standard",
    foodState: "prosperous",
    recentLatencyMs: 100,
    ...overrides,
  };
}

describe("ProviderRouter.choose", () => {
  it("filters out providers missing a required capability", () => {
    const router = new ProviderRouter();
    const taskProfile: TaskProfile = { requiredCapabilities: ["vision"] };
    const providers = [
      provider({ providerId: "no-vision", capabilities: ["tool-use"] }),
      provider({ providerId: "has-vision", capabilities: ["vision", "tool-use"] }),
    ];

    const result = router.choose(taskProfile, providers);
    expect(result.map((p) => p.providerId)).toEqual(["has-vision"]);
  });

  it("filters out providers below the required model tier", () => {
    const router = new ProviderRouter();
    const taskProfile: TaskProfile = { requiredModelTier: "flagship" };
    const providers = [
      provider({ providerId: "economy", modelTier: "economy" }),
      provider({ providerId: "standard", modelTier: "standard" }),
      provider({ providerId: "flagship", modelTier: "flagship" }),
    ];

    const result = router.choose(taskProfile, providers);
    expect(result.map((p) => p.providerId)).toEqual(["flagship"]);
  });

  it("ranks healthier food state ahead of a lower-latency but hungrier provider", () => {
    const router = new ProviderRouter();
    const providers = [
      provider({ providerId: "hungry-fast", foodState: "reserve", recentLatencyMs: 10 }),
      provider({ providerId: "healthy-slow", foodState: "prosperous", recentLatencyMs: 500 }),
    ];

    const result = router.choose({}, providers);
    expect(result.map((p) => p.providerId)).toEqual(["healthy-slow", "hungry-fast"]);
  });

  it("given equal food state, prefers the tier closest to what the task requires over a bigger tier", () => {
    const router = new ProviderRouter();
    const taskProfile: TaskProfile = { requiredModelTier: "standard" };
    const providers = [
      provider({ providerId: "flagship", modelTier: "flagship" }),
      provider({ providerId: "standard", modelTier: "standard" }),
    ];

    const result = router.choose(taskProfile, providers);
    expect(result.map((p) => p.providerId)).toEqual(["standard", "flagship"]);
  });

  it("given equal food state and tier fit, breaks ties on lower recent latency", () => {
    const router = new ProviderRouter();
    const providers = [
      provider({ providerId: "slower", recentLatencyMs: 800 }),
      provider({ providerId: "faster", recentLatencyMs: 200 }),
    ];

    const result = router.choose({}, providers);
    expect(result.map((p) => p.providerId)).toEqual(["faster", "slower"]);
  });

  it("returns an empty array when no provider satisfies the task's requirements", () => {
    const router = new ProviderRouter();
    const taskProfile: TaskProfile = { requiredCapabilities: ["vision"] };
    const providers = [provider({ providerId: "solo", capabilities: [] })];

    expect(router.choose(taskProfile, providers)).toEqual([]);
  });
});
