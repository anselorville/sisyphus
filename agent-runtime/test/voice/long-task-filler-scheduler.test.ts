import { afterEach, describe, expect, it, vi } from "vitest";

import { LongTaskFillerScheduler } from "../../src/voice/long-task-filler-scheduler.js";

describe("LongTaskFillerScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the long-task threshold and then repeats at the interval", () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const scheduler = new LongTaskFillerScheduler({
      startDelayMs: 5_000,
      intervalMs: 10_000,
      fillerTexts: ["还在查，快了。"],
      onSpeak: (text) => spoken.push(text),
    });

    scheduler.begin("tool-call-1");
    vi.advanceTimersByTime(4_999);
    expect(spoken).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(spoken).toHaveLength(1);

    vi.advanceTimersByTime(9_999);
    expect(spoken).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(spoken).toHaveLength(2);
  });

  it("stops scheduled fillers when the last tool call completes", () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const scheduler = new LongTaskFillerScheduler({
      startDelayMs: 5_000,
      intervalMs: 10_000,
      onSpeak: (text) => spoken.push(text),
    });

    scheduler.begin("tool-call-1");
    scheduler.end("tool-call-1");
    vi.advanceTimersByTime(60_000);

    expect(spoken).toHaveLength(0);
  });

  it("re-arms the idle threshold after real progress activity", () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const scheduler = new LongTaskFillerScheduler({
      startDelayMs: 5_000,
      intervalMs: 10_000,
      onSpeak: (text) => spoken.push(text),
    });

    scheduler.begin("tool-call-1");
    vi.advanceTimersByTime(4_000);
    scheduler.touch();
    vi.advanceTimersByTime(4_999);
    expect(spoken).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(spoken).toHaveLength(1);
  });
});
