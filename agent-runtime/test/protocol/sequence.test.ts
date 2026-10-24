import { describe, expect, it } from "vitest";

import { EventSequencer } from "../../src/protocol/sequence.js";

describe("EventSequencer", () => {
  it("is strictly increasing", () => {
    const sequencer = new EventSequencer(100);

    expect([sequencer.next(), sequencer.next(), sequencer.next()]).toEqual([101, 102, 103]);
  });

  it("a restarted process starts above anything its predecessor could have emitted", () => {
    const before = new EventSequencer();
    let lastBeforeRestart = 0;
    for (let i = 0; i < 5_000; i += 1) lastBeforeRestart = before.next();

    // A restart a few ms later is seeded from the clock, ahead of a 5k-event burst.
    const restartedAt = Date.now() + 10;
    const after = new EventSequencer(restartedAt * 1000);

    expect(after.next()).toBeGreaterThan(lastBeforeRestart);
    expect(Number.isSafeInteger(after.next())).toBe(true);
  });

  it("two modules sharing one sequencer never collide", () => {
    const shared = new EventSequencer();
    const seen = new Set<number>();
    for (let i = 0; i < 1_000; i += 1) {
      seen.add(shared.next()); // "executor"
      seen.add(shared.next()); // "diplomacy"
      seen.add(shared.next()); // "scribe"
    }

    expect(seen.size).toBe(3_000);
  });
});
