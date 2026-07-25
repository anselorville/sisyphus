import { describe, expect, it } from "vitest";

import type { TrafficTaskSnapshot } from "../../src/voice/traffic-commander.js";
import { TrafficCommander } from "../../src/voice/traffic-commander.js";

function snapshot(overrides: Partial<TrafficTaskSnapshot> & Pick<TrafficTaskSnapshot, "taskId">): TrafficTaskSnapshot {
  return { running: true, ...overrides };
}

describe("TrafficCommander -- receipt ack (700ms default)", () => {
  it("does not ack before the grace period has elapsed", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({ taskId: "t1", finalTranscriptAtMs: 0 });

    expect(commander.evaluate(snap, 0)).toBeNull();
    expect(commander.evaluate(snap, 500)).toBeNull();
    expect(commander.evaluate(snap, 699)).toBeNull();
  });

  it("emits exactly one local receipt acknowledgement once 700ms have elapsed", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({ taskId: "t1", finalTranscriptAtMs: 0 });

    expect(commander.evaluate(snap, 700)).toMatchObject({ kind: "receipt", taskId: "t1" });
  });

  it("never re-acks the same final transcript on later calls", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({ taskId: "t1", finalTranscriptAtMs: 0 });

    expect(commander.evaluate(snap, 700)).toMatchObject({ kind: "receipt" });
    expect(commander.evaluate(snap, 800)).toBeNull();
    expect(commander.evaluate(snap, 60_000)).toBeNull();
  });

  it("acks again once a new final transcript arrives for the same task", () => {
    const commander = new TrafficCommander();
    expect(commander.evaluate(snapshot({ taskId: "t1", finalTranscriptAtMs: 0 }), 700)).toMatchObject({
      kind: "receipt",
    });

    const nextTurn = snapshot({ taskId: "t1", finalTranscriptAtMs: 10_000 });
    expect(commander.evaluate(nextTurn, 10_500)).toBeNull(); // still within grace for the new turn
    expect(commander.evaluate(nextTurn, 10_700)).toMatchObject({ kind: "receipt" });
  });

  it("respects a custom ackGraceMs and receiptText", () => {
    const commander = new TrafficCommander({ ackGraceMs: 100, receiptText: "custom-receipt" });
    const snap = snapshot({ taskId: "t1", finalTranscriptAtMs: 0 });

    expect(commander.evaluate(snap, 99)).toBeNull();
    expect(commander.evaluate(snap, 100)).toMatchObject({ kind: "receipt", text: "custom-receipt" });
  });
});

describe("TrafficCommander -- real progress (3s silence, never fabricated)", () => {
  it("does not speak before a real phase has sat unspoken for 3s", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({ taskId: "t2", phase: "running tests", phaseChangedAtMs: 0 });

    expect(commander.evaluate(snap, 0)).toBeNull();
    expect(commander.evaluate(snap, 2_999)).toBeNull();
  });

  it("speaks exactly one real progress utterance once 3s have elapsed", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({ taskId: "t2", phase: "running tests", phaseChangedAtMs: 0 });

    expect(commander.evaluate(snap, 3_000)).toMatchObject({
      kind: "progress",
      taskId: "t2",
      text: expect.stringContaining("running tests"),
    });
  });

  it("never fabricates a progress utterance when no real phase has been observed", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({ taskId: "t2" }); // running, but no phase supplied at all

    expect(commander.evaluate(snap, 3_000)).toBeNull();
    expect(commander.evaluate(snap, 999_999)).toBeNull();
  });

  it("never speaks progress for a task that is not running", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({ taskId: "t2", running: false, phase: "done-ish", phaseChangedAtMs: 0 });

    expect(commander.evaluate(snap, 999_999)).toBeNull();
  });

  it("respects a custom progressSilenceMs and formatProgress", () => {
    const commander = new TrafficCommander({
      progressSilenceMs: 200,
      formatProgress: (phase) => `custom:${phase}`,
    });
    const snap = snapshot({ taskId: "t2", phase: "reading files", phaseChangedAtMs: 0 });

    expect(commander.evaluate(snap, 199)).toBeNull();
    expect(commander.evaluate(snap, 200)).toMatchObject({ kind: "progress", text: "custom:reading files" });
  });
});

describe("TrafficCommander -- no phase change means no repeated utterance", () => {
  it("does not repeat the same phase no matter how much time passes", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({ taskId: "t3", phase: "reading files", phaseChangedAtMs: 0 });

    expect(commander.evaluate(snap, 3_000)).toMatchObject({ kind: "progress" });
    expect(commander.evaluate(snap, 3_100)).toBeNull();
    expect(commander.evaluate(snap, 1_000_000)).toBeNull();
  });
});

describe("TrafficCommander -- minimum 5s gap between progress utterances", () => {
  it("holds back a second, genuinely different phase until 5s have passed since the last utterance", () => {
    const commander = new TrafficCommander();

    expect(commander.evaluate(snapshot({ taskId: "t4", phase: "phase-a", phaseChangedAtMs: 0 }), 3_000)).toMatchObject(
      { kind: "progress" },
    );

    // phase changed almost immediately after the first utterance -- still
    // rate-limited by the 5s floor, even though the phase itself is "new".
    expect(
      commander.evaluate(snapshot({ taskId: "t4", phase: "phase-b", phaseChangedAtMs: 3_400 }), 3_400),
    ).toBeNull();
    expect(
      commander.evaluate(snapshot({ taskId: "t4", phase: "phase-b", phaseChangedAtMs: 3_400 }), 7_999),
    ).toBeNull();

    expect(
      commander.evaluate(snapshot({ taskId: "t4", phase: "phase-b", phaseChangedAtMs: 3_400 }), 8_000),
    ).toMatchObject({ kind: "progress", text: expect.stringContaining("phase-b") });
  });

  it("respects a custom minProgressGapMs", () => {
    const commander = new TrafficCommander({ minProgressGapMs: 1_000, progressSilenceMs: 0 });

    expect(commander.evaluate(snapshot({ taskId: "t4", phase: "a", phaseChangedAtMs: 0 }), 0)).toMatchObject({
      kind: "progress",
    });
    expect(commander.evaluate(snapshot({ taskId: "t4", phase: "b", phaseChangedAtMs: 500 }), 999)).toBeNull();
    expect(commander.evaluate(snapshot({ taskId: "t4", phase: "b", phaseChangedAtMs: 500 }), 1_000)).toMatchObject({
      kind: "progress",
    });
  });
});

describe("TrafficCommander -- per-task isolation and cleanup", () => {
  it("tracks bookkeeping independently per task id", () => {
    const commander = new TrafficCommander();

    expect(commander.evaluate(snapshot({ taskId: "a", phase: "x", phaseChangedAtMs: 0 }), 3_000)).toMatchObject({
      kind: "progress",
    });
    // A different task with the same phase timing must fire independently,
    // not be suppressed by task "a"'s bookkeeping.
    expect(commander.evaluate(snapshot({ taskId: "b", phase: "x", phaseChangedAtMs: 0 }), 3_000)).toMatchObject({
      kind: "progress",
    });
  });

  it("forget() releases bookkeeping so a later snapshot for the same id starts fresh", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({ taskId: "t5", finalTranscriptAtMs: 0 });

    expect(commander.evaluate(snap, 700)).toMatchObject({ kind: "receipt" });
    expect(commander.evaluate(snap, 800)).toBeNull();

    commander.forget("t5");

    expect(commander.evaluate(snap, 900)).toMatchObject({ kind: "receipt" });
  });
});

describe("TrafficCommander -- at most one directive per call", () => {
  it("prefers the receipt ack over a simultaneously-due progress utterance", () => {
    const commander = new TrafficCommander();
    const snap = snapshot({
      taskId: "t6",
      finalTranscriptAtMs: 0,
      phase: "already running",
      phaseChangedAtMs: 0,
    });

    const directive = commander.evaluate(snap, 3_000); // both the 700ms ack and 3s progress gates are open
    expect(directive).toMatchObject({ kind: "receipt" });
  });
});
