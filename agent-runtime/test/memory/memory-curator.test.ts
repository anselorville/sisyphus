import { describe, expect, it } from "vitest";

import { MemoryCurator } from "../../src/memory/memory-curator.js";
import type { MemoryEvent, MemoryEventKind } from "../../src/memory/memory-curator.js";

function eventOfKind(kind: MemoryEventKind, overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  const base: Record<MemoryEventKind, MemoryEvent> = {
    raw_tool_log: { kind: "raw_tool_log", content: "$ npm test\n... 400 lines of raw stdout ..." },
    email_body: { kind: "email_body", content: "Hi team, per our conversation the attached report covers Q3..." },
    assistant_thinking: {
      kind: "assistant_thinking",
      content: "First I should check the file, then I could try the other approach because...",
    },
    raw_conversation: { kind: "raw_conversation", content: "User: hi\nAssistant: hello, how can I help?" },
    unverified_claim: { kind: "unverified_claim", content: "The user probably prefers dark mode" },
    explicit_remember_request: { kind: "explicit_remember_request", content: "Please remember I'm allergic to peanuts" },
    verified_fact: { kind: "verified_fact", content: "User's timezone is America/New_York", verified: true },
    task_result_summary: { kind: "task_result_summary", content: "Sent the Q3 report to finance@example.com" },
    observed_preference: {
      kind: "observed_preference",
      content: "prefers metric units",
      subjectKey: "prefers_metric_units",
    },
  };
  return { ...base[kind], ...overrides };
}

describe("MemoryCurator.consider (Step 2 mandated test)", () => {
  const curator = new MemoryCurator();

  it.each(["raw_tool_log", "email_body", "assistant_thinking", "raw_conversation"] as const)(
    "does not persist %s as personal memory",
    async (kind) => {
      expect(await curator.consider(eventOfKind(kind))).toMatchObject({ persist: false });
    },
  );
});

describe("MemoryCurator.consider -- fuller coverage", () => {
  it("persists an explicit user 'remember this' request", async () => {
    const curator = new MemoryCurator();
    const result = await curator.consider(eventOfKind("explicit_remember_request"));
    expect(result.persist).toBe(true);
    expect(result.compressedContent).toContain("peanuts");
  });

  it("does not persist a one-off unverified claim", async () => {
    const curator = new MemoryCurator();
    const result = await curator.consider(eventOfKind("unverified_claim"));
    expect(result.persist).toBe(false);
  });

  it("does not persist a 'fact' that has not actually been verified", async () => {
    const curator = new MemoryCurator();
    const result = await curator.consider(eventOfKind("verified_fact", { verified: false }));
    expect(result.persist).toBe(false);
  });

  it("persists a fact once it has actually been verified", async () => {
    const curator = new MemoryCurator();
    const result = await curator.consider(eventOfKind("verified_fact"));
    expect(result.persist).toBe(true);
  });

  it("persists a reusable task-result summary", async () => {
    const curator = new MemoryCurator();
    const result = await curator.consider(eventOfKind("task_result_summary"));
    expect(result.persist).toBe(true);
  });

  it("does not persist a preference until it has repeated to the configured threshold", async () => {
    const curator = new MemoryCurator({ preferenceRepetitionThreshold: 3 });
    const pref = eventOfKind("observed_preference");

    expect((await curator.consider(pref)).persist).toBe(false);
    expect((await curator.consider(pref)).persist).toBe(false);
    expect((await curator.consider(pref)).persist).toBe(true);
  });

  it("keeps repetition counts distinct per subjectKey", async () => {
    const curator = new MemoryCurator({ preferenceRepetitionThreshold: 2 });
    const metric = eventOfKind("observed_preference", { subjectKey: "prefers_metric_units" });
    const darkMode = eventOfKind("observed_preference", { subjectKey: "prefers_dark_mode" });

    expect((await curator.consider(metric)).persist).toBe(false); // metric count=1
    expect((await curator.consider(metric)).persist).toBe(true); // metric count=2, threshold reached
    expect((await curator.consider(darkMode)).persist).toBe(false); // darkMode count=1, unaffected by metric's count
  });

  it("never persists more than a short compressed summary, even for an allowed kind", async () => {
    const curator = new MemoryCurator({ maxCompressedLength: 50 });
    const longContent = "x".repeat(5000);
    const result = await curator.consider(eventOfKind("task_result_summary", { content: longContent }));
    expect(result.persist).toBe(true);
    expect(result.compressedContent).toBeDefined();
    expect(result.compressedContent!.length).toBeLessThanOrEqual(50);
    expect(result.compressedContent!.length).toBeLessThan(longContent.length);
  });

  it("does not persist empty content, even for an otherwise-eligible kind", async () => {
    const curator = new MemoryCurator();
    const result = await curator.consider(eventOfKind("explicit_remember_request", { content: "   " }));
    expect(result.persist).toBe(false);
  });
});
