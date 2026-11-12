import { describe, expect, it } from "vitest";

import { TurnTrace } from "../../src/telemetry/turn-trace.js";

function makeTrace(transcriptAt?: string): { trace: TurnTrace; advance: (ms: number) => void } {
  let now = 1_000;
  const trace = new TurnTrace({ now: () => now, transcriptAt });
  return { trace, advance: (ms) => { now += ms; } };
}

describe("TurnTrace", () => {
  it("records marks as milliseconds since the turn started", () => {
    const { trace, advance } = makeTrace("2026-11-09T07:45:03.000Z");
    advance(5);
    trace.mark("decided");
    advance(40);
    trace.mark("task_started");
    trace.set({ route: "capability_match", role: "web" });

    expect(trace.toPayload()).toEqual({
      route: "capability_match",
      role: "web",
      transcript_at: "2026-11-09T07:45:03.000Z",
      marks: { decided: 5, task_started: 45 },
      speech: {},
      tools: [],
    });
  });

  it("mark overwrites (a queued turn is decided twice); markOnce keeps the first", () => {
    const { trace, advance } = makeTrace();
    advance(3);
    trace.mark("decided");
    trace.markOnce("first_text");
    advance(900);
    trace.mark("decided");
    trace.markOnce("first_text");

    expect(trace.toPayload()["marks"]).toEqual({ decided: 903, first_text: 3 });
    expect(trace.toPayload()).not.toHaveProperty("transcript_at");
  });

  it("keeps the first enqueue of each speech kind, and first_speech overall", () => {
    const { trace, advance } = makeTrace();
    advance(700);
    trace.speech("receipt");
    advance(300);
    trace.speech("progress");
    advance(300);
    trace.speech("progress");

    const payload = trace.toPayload();
    expect(payload["speech"]).toEqual({ receipt: 700, progress: 1_000 });
    expect(payload["marks"]).toEqual({ first_speech: 700 });
  });

  it("times tool calls, leaving an unfinished one without a duration", () => {
    const { trace, advance } = makeTrace();
    advance(100);
    trace.toolStarted("c1", "web_search");
    advance(250);
    trace.toolEnded("c1", true);
    trace.toolEnded("c1", false); // a duplicate end is ignored
    trace.toolEnded("missing", true); // as is an end without a start
    trace.toolStarted("c2", "web_fetch");

    expect(trace.toPayload()["tools"]).toEqual([
      { name: "web_search", start_ms: 100, duration_ms: 250, ok: true },
      { name: "web_fetch", start_ms: 350 },
    ]);
  });
});
