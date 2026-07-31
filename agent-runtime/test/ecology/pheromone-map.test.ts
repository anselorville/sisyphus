import { describe, expect, it } from "vitest";

import { InvalidPheromonePathError, PheromoneMap, evaluateRoleLifecycle } from "../../src/ecology/pheromone-map.js";
import type { PheromoneContext, PheromonePathKey, RoleExperienceSnapshot } from "../../src/ecology/pheromone-map.js";

const HOME: PheromoneContext = { deviceId: "phone-1", networkId: "home-wifi" };
const CELLULAR: PheromoneContext = { deviceId: "phone-1", networkId: "cellular" };

function path(overrides: Partial<PheromonePathKey> = {}): PheromonePathKey {
  return { taskFeature: "mail.send", roleId: "mail", context: HOME, ...overrides };
}

describe("PheromoneMap.reinforce (Step 3 mandated coverage)", () => {
  it("raises a path's weight on success", () => {
    const map = new PheromoneMap();
    const first = map.reinforce(path(), 0);
    expect(first.weight).toBeGreaterThan(0);

    const second = map.reinforce(path(), 1_000);
    expect(second.weight).toBeGreaterThan(first.weight);
    expect(second.successes).toBe(2);
  });
});

describe("PheromoneMap.penalize -- user correction vs. ordinary failure", () => {
  it("penalizes a user correction much more sharply than an ordinary failure", () => {
    const map = new PheromoneMap();
    const ordinary = path({ roleId: "mail-ordinary" });
    const corrected = path({ roleId: "mail-corrected" });

    const beforeOrdinary = map.reinforce(ordinary, 0).weight;
    const beforeCorrected = map.reinforce(corrected, 0).weight;
    expect(beforeOrdinary).toBeCloseTo(beforeCorrected);

    const afterOrdinary = map.penalize(ordinary, 1_000).weight;
    const afterCorrected = map.penalize(corrected, 1_000, { userCorrection: true }).weight;

    const ordinaryDrop = beforeOrdinary - afterOrdinary;
    const correctedDrop = beforeCorrected - afterCorrected;

    expect(correctedDrop).toBeGreaterThan(ordinaryDrop * 2);
    expect(map.get(corrected)?.userCorrections).toBe(1);
    expect(map.get(ordinary)?.failures).toBe(1);
  });
});

describe("PheromoneMap.decay -- injectable clock, no real waiting", () => {
  it("reduces an unused path's weight over elapsed time", () => {
    const map = new PheromoneMap();
    const p = path();
    const reinforced = map.reinforce(p, 0).weight;

    map.decay(30 * 24 * 60 * 60 * 1000); // 30 days later

    const decayed = map.get(p)!.weight;
    expect(decayed).toBeLessThan(reinforced);
    expect(decayed).toBeGreaterThanOrEqual(0);
  });

  it("does not double-decay when called again for the same instant", () => {
    const map = new PheromoneMap();
    const p = path();
    map.reinforce(p, 0);

    map.decay(1_000);
    const once = map.get(p)!.weight;
    map.decay(1_000);
    const twice = map.get(p)!.weight;

    expect(twice).toBe(once);
  });
});

describe("PheromoneMap contexts -- different device/network contexts are different keys", () => {
  it("does not let a weight change on one context affect the same task-feature/role on another context", () => {
    const map = new PheromoneMap();
    const home = path({ context: HOME });
    const cellular = path({ context: CELLULAR });

    map.reinforce(home, 0);
    const cellularBefore = map.reinforce(cellular, 0).weight;

    map.penalize(home, 1_000, { userCorrection: true });

    expect(map.get(cellular)!.weight).toBe(cellularBefore);
    expect(map.get(home)!.weight).toBeLessThan(cellularBefore);
  });
});

describe("PheromoneMap.rank", () => {
  it("orders paths by current effective weight, descending", () => {
    const map = new PheromoneMap();
    const weak = path({ roleId: "mail-weak" });
    const strong = path({ roleId: "mail-strong" });

    map.reinforce(weak, 0);
    map.reinforce(strong, 0);
    map.reinforce(strong, 1_000);
    map.reinforce(strong, 2_000);

    const ranked = map.rank({ taskFeature: "mail.send" });
    expect(ranked.map((entry) => entry.path.roleId)).toEqual(["mail-strong", "mail-weak"]);
  });

  it("returns an empty list when nothing matches the filter", () => {
    const map = new PheromoneMap();
    map.reinforce(path(), 0);
    expect(map.rank({ taskFeature: "no-such-feature" })).toEqual([]);
  });
});

describe("PheromoneMap validation", () => {
  it("rejects an empty taskFeature/roleId/deviceId/networkId", () => {
    const map = new PheromoneMap();
    expect(() => map.reinforce(path({ taskFeature: "" }), 0)).toThrow(InvalidPheromonePathError);
    expect(() => map.reinforce(path({ roleId: "" }), 0)).toThrow(InvalidPheromonePathError);
    expect(() => map.reinforce(path({ context: { deviceId: "", networkId: "home-wifi" } }), 0)).toThrow(
      InvalidPheromonePathError,
    );
  });
});

describe("evaluateRoleLifecycle (Step 6 promotion/retirement rules)", () => {
  function snapshot(overrides: Partial<RoleExperienceSnapshot> = {}): RoleExperienceSnapshot {
    return {
      crossTaskSuccessCount: 0,
      consecutiveFailures: 0,
      hadSeriousIncident: false,
      lastUsedAtMs: 0,
      ...overrides,
    };
  }

  it("promotes to resident after 3 cross-task successes with no serious incident", () => {
    const decision = evaluateRoleLifecycle(snapshot({ crossTaskSuccessCount: 3 }), { nowMs: 0 });
    expect(decision.action).toBe("promote_resident");
  });

  it("does not promote when a serious incident accompanied the successes", () => {
    const decision = evaluateRoleLifecycle(snapshot({ crossTaskSuccessCount: 3, hadSeriousIncident: true }), {
      nowMs: 0,
    });
    expect(decision.action).not.toBe("promote_resident");
  });

  it("sleeps after 2 consecutive failures, even if it would otherwise qualify for promotion", () => {
    const decision = evaluateRoleLifecycle(snapshot({ crossTaskSuccessCount: 5, consecutiveFailures: 2 }), {
      nowMs: 0,
    });
    expect(decision.action).toBe("sleep");
  });

  it("retires after 5 consecutive failures instead of merely sleeping (Roadmap #5)", () => {
    const decision = evaluateRoleLifecycle(snapshot({ consecutiveFailures: 5 }), { nowMs: 0 });
    expect(decision.action).toBe("retire");
    expect(decision.reason).toMatch(/5 consecutive failures/);
  });

  it("still sleeps (not retires) at exactly one below the retire threshold", () => {
    const decision = evaluateRoleLifecycle(snapshot({ consecutiveFailures: 4 }), { nowMs: 0 });
    expect(decision.action).toBe("sleep");
  });

  it("retire wins over an otherwise-qualifying promotion, exactly like sleep does", () => {
    const decision = evaluateRoleLifecycle(snapshot({ crossTaskSuccessCount: 10, consecutiveFailures: 5 }), {
      nowMs: 0,
    });
    expect(decision.action).toBe("retire");
  });

  it("signals release-session-keep-gene once unused past the threshold", () => {
    const longUnusedThresholdMs = 14 * 24 * 60 * 60 * 1000;
    const decision = evaluateRoleLifecycle(snapshot({ lastUsedAtMs: 0 }), {
      nowMs: longUnusedThresholdMs,
      longUnusedThresholdMs,
    });
    expect(decision.action).toBe("release_session_keep_gene");
  });

  it("makes no change when no threshold is crossed", () => {
    const decision = evaluateRoleLifecycle(snapshot({ crossTaskSuccessCount: 1, lastUsedAtMs: 1_000 }), {
      nowMs: 2_000,
    });
    expect(decision.action).toBe("no_change");
  });
});
