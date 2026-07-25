import { describe, expect, it } from "vitest";

import { Queen } from "../../src/ecology/queen.js";
import type { EcologySnapshot } from "../../src/ecology/queen.js";

function snapshot(overrides: Partial<EcologySnapshot> & Pick<EcologySnapshot, "food">): EcologySnapshot {
  return {
    activePopulation: 1,
    activeCap: 4,
    isolationActivePopulation: 0,
    isolationCap: 1,
    ...overrides,
  };
}

describe("Queen boundary (Step 1 mandated test)", () => {
  it("has no user prompt or business tool surface", () => {
    const queen = new Queen();
    expect("prompt" in queen).toBe(false);
    expect("tools" in queen).toBe(false);
  });
});

describe("Queen.evaluate -- ecology state transitions (Step 2 mandated test)", () => {
  it("stops births in reserve and sleeps workers in hibernation", () => {
    const queen = new Queen();
    expect(queen.evaluate(snapshot({ food: "reserve" }))).toContainEqual({ kind: "freeze_births" });
    expect(queen.evaluate(snapshot({ food: "hibernating" }))).toContainEqual({ kind: "sleep_non_voice_workers" });
  });
});

describe("Queen.evaluate -- fuller food-state coverage", () => {
  const queen = new Queen();

  it("prosperous allows hatching and expansion when there is population headroom", () => {
    const decisions = queen.evaluate(snapshot({ food: "prosperous", activePopulation: 1, activeCap: 4 }));

    expect(decisions).toContainEqual({ kind: "allow_hatch" });
    expect(decisions).toContainEqual({ kind: "allow_expand" });
    expect(decisions).not.toContainEqual({ kind: "freeze_births" });
    expect(decisions).not.toContainEqual({ kind: "pause_exploration" });
    expect(decisions).not.toContainEqual({ kind: "sleep_non_voice_workers" });
  });

  it("prosperous still freezes births once the population cap is already full", () => {
    const decisions = queen.evaluate(snapshot({ food: "prosperous", activePopulation: 4, activeCap: 4 }));

    expect(decisions).toContainEqual({ kind: "allow_expand" });
    expect(decisions).toContainEqual({ kind: "freeze_births" });
    expect(decisions).not.toContainEqual({ kind: "allow_hatch" });
  });

  it("conserving stops non-essential exploration but does not freeze births or sleep workers", () => {
    const decisions = queen.evaluate(snapshot({ food: "conserving" }));

    expect(decisions).toContainEqual({ kind: "pause_exploration" });
    expect(decisions).not.toContainEqual({ kind: "freeze_births" });
    expect(decisions).not.toContainEqual({ kind: "sleep_non_voice_workers" });
    expect(decisions).not.toContainEqual({ kind: "allow_hatch" });
    expect(decisions).not.toContainEqual({ kind: "allow_expand" });
  });

  it("reserve freezes births specifically, on top of pausing exploration", () => {
    const decisions = queen.evaluate(snapshot({ food: "reserve" }));

    expect(decisions).toContainEqual({ kind: "pause_exploration" });
    expect(decisions).toContainEqual({ kind: "freeze_births" });
    expect(decisions).not.toContainEqual({ kind: "sleep_non_voice_workers" });
  });

  it("hibernating sleeps non-voice workers specifically, on top of every reserve-level restriction", () => {
    const decisions = queen.evaluate(snapshot({ food: "hibernating" }));

    expect(decisions).toContainEqual({ kind: "pause_exploration" });
    expect(decisions).toContainEqual({ kind: "freeze_births" });
    expect(decisions).toContainEqual({ kind: "sleep_non_voice_workers" });
  });

  it("gates isolated-lifecycle hatching by its own separate isolationCap", () => {
    const atCap = queen.evaluate(
      snapshot({ food: "prosperous", isolationActivePopulation: 1, isolationCap: 1 }),
    );
    const underCap = queen.evaluate(
      snapshot({ food: "prosperous", isolationActivePopulation: 0, isolationCap: 1 }),
    );

    expect(atCap).not.toContainEqual({ kind: "allow_isolated_hatch" });
    expect(underCap).toContainEqual({ kind: "allow_isolated_hatch" });
  });
});

describe("Queen evaluation cadence -- injectable clock/counter, no real timers", () => {
  it("is due immediately on a brand-new Queen", () => {
    const queen = new Queen({ evaluationIntervalMs: 30_000, evaluationEventThreshold: 20 });
    expect(queen.isEvaluationDue(0)).toBe(true);
  });

  it("becomes due once the configured interval elapses, without needing 20 events", () => {
    const queen = new Queen({ evaluationIntervalMs: 30_000, evaluationEventThreshold: 20 });
    expect(queen.evaluateOnCadence(0, snapshot({ food: "prosperous" }))).not.toBeNull();

    expect(queen.isEvaluationDue(29_999)).toBe(false);
    expect(queen.isEvaluationDue(30_000)).toBe(true);
  });

  it("becomes due once the configured event-count threshold is reached, before the interval elapses", () => {
    const queen = new Queen({ evaluationIntervalMs: 30_000, evaluationEventThreshold: 3 });
    queen.evaluateOnCadence(0, snapshot({ food: "prosperous" }));

    queen.recordTaskTerminalEvent();
    queen.recordTaskTerminalEvent();
    expect(queen.isEvaluationDue(1_000)).toBe(false);

    queen.recordTaskTerminalEvent();
    expect(queen.isEvaluationDue(1_000)).toBe(true);
  });

  it("evaluateOnCadence resets both the timer and the event counter after firing", () => {
    const queen = new Queen({ evaluationIntervalMs: 30_000, evaluationEventThreshold: 3 });
    queen.evaluateOnCadence(0, snapshot({ food: "prosperous" }));
    queen.recordTaskTerminalEvent();
    queen.recordTaskTerminalEvent();
    queen.recordTaskTerminalEvent();

    expect(queen.evaluateOnCadence(1_000, snapshot({ food: "prosperous" }))).not.toBeNull();
    expect(queen.isEvaluationDue(1_001)).toBe(false);
  });

  it("returns null (and leaves cadence bookkeeping untouched) when not yet due", () => {
    const queen = new Queen({ evaluationIntervalMs: 30_000, evaluationEventThreshold: 20 });
    queen.evaluateOnCadence(0, snapshot({ food: "prosperous" }));

    expect(queen.evaluateOnCadence(1_000, snapshot({ food: "prosperous" }))).toBeNull();
  });
});
