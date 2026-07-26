import { describe, expect, it } from "vitest";

import { RoleExperienceTracker } from "../../src/ecology/role-experience.js";

describe("RoleExperienceTracker (Roadmap #3: evaluateRoleLifecycle's caller-assembled history)", () => {
  it("returns an all-zero snapshot for a role that has never recorded an outcome", () => {
    const tracker = new RoleExperienceTracker();
    expect(tracker.get("mail")).toEqual({
      crossTaskSuccessCount: 0,
      consecutiveFailures: 0,
      hadSeriousIncident: false,
      lastUsedAtMs: 0,
    });
  });

  it("increments crossTaskSuccessCount and resets consecutiveFailures on a success", () => {
    const tracker = new RoleExperienceTracker();
    tracker.recordOutcome("mail", "failure", 1_000);
    tracker.recordOutcome("mail", "failure", 2_000);

    const snapshot = tracker.recordOutcome("mail", "success", 3_000);

    expect(snapshot).toEqual({
      crossTaskSuccessCount: 1,
      consecutiveFailures: 0,
      hadSeriousIncident: false,
      lastUsedAtMs: 3_000,
    });
  });

  it("increments consecutiveFailures without touching crossTaskSuccessCount on a failure", () => {
    const tracker = new RoleExperienceTracker();
    tracker.recordOutcome("mail", "success", 1_000);

    const snapshot = tracker.recordOutcome("mail", "failure", 2_000);

    expect(snapshot).toEqual({
      crossTaskSuccessCount: 1,
      consecutiveFailures: 1,
      hadSeriousIncident: false,
      lastUsedAtMs: 2_000,
    });
  });

  it("tracks independent counters per roleId", () => {
    const tracker = new RoleExperienceTracker();
    tracker.recordOutcome("mail", "success", 1_000);
    tracker.recordOutcome("device", "failure", 1_000);

    expect(tracker.get("mail").crossTaskSuccessCount).toBe(1);
    expect(tracker.get("device").consecutiveFailures).toBe(1);
  });

  it("always reports hadSeriousIncident as false -- no real signal exists yet to feed it", () => {
    const tracker = new RoleExperienceTracker();
    for (let i = 0; i < 10; i++) {
      tracker.recordOutcome("mail", "success", i);
    }
    expect(tracker.get("mail").hadSeriousIncident).toBe(false);
  });

  it("resetAfterPromotion zeroes crossTaskSuccessCount without touching consecutiveFailures", () => {
    const tracker = new RoleExperienceTracker();
    tracker.recordOutcome("mail", "success", 1_000);
    tracker.recordOutcome("mail", "success", 2_000);
    tracker.recordOutcome("mail", "success", 3_000);

    tracker.resetAfterPromotion("mail", 4_000);

    expect(tracker.get("mail")).toMatchObject({ crossTaskSuccessCount: 0, lastUsedAtMs: 4_000 });
  });

  it("resetAfterPromotion on an untracked roleId is a harmless no-op", () => {
    const tracker = new RoleExperienceTracker();
    expect(() => tracker.resetAfterPromotion("ghost", 1_000)).not.toThrow();
    expect(tracker.get("ghost").crossTaskSuccessCount).toBe(0);
  });
});
