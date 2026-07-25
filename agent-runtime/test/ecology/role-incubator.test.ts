import { describe, expect, it } from "vitest";

import { validateGenome } from "../../src/ecology/gene-bank.js";
import type { RoleGenome } from "../../src/ecology/gene-bank.js";
import { CAPABILITY_GAP_REASONS, InvalidCapabilityGapError, RoleIncubator } from "../../src/ecology/role-incubator.js";
import type { CapabilityGap } from "../../src/ecology/role-incubator.js";

function nearestGenome(overrides: Partial<RoleGenome> = {}): RoleGenome {
  return {
    roleId: "general",
    lineage: [],
    capabilities: ["qa", "task-clarification"],
    tools: ["read"],
    promptFragments: ["general.md"],
    modelPolicy: { preferredClass: "balanced", thinkingLevel: "medium" },
    birthReason: "first_release_baseline",
    deathConditions: ["never_used_in_30_days"],
    lifecycle: { state: "resident", maxTaskAgeSeconds: 1800 },
    fitness: { successes: 10, failures: 1, userCorrections: 0 },
    ...overrides,
  };
}

function gap(overrides: Partial<CapabilityGap> = {}): CapabilityGap {
  return {
    reason: "missing_capability",
    roleId: "mail-worker",
    missingCapabilities: ["mail-search", "mail-send"],
    requiredTools: ["mail_search", "mail_send"],
    requiredPromptFragments: ["mail-worker.md"],
    ...overrides,
  };
}

describe("RoleIncubator.propose", () => {
  const incubator = new RoleIncubator();

  it("copies the nearest genome and adds only the gap's missing tools/capabilities/prompt fragments", () => {
    const proposed = incubator.propose(gap(), nearestGenome());

    expect(proposed.capabilities).toEqual(["qa", "task-clarification", "mail-search", "mail-send"]);
    expect(proposed.tools).toEqual(["read", "mail_search", "mail_send"]);
    expect(proposed.promptFragments).toEqual(["general.md", "mail-worker.md"]);
  });

  it("never invents a capability or tool the gap did not name", () => {
    const proposed = incubator.propose(
      gap({ missingCapabilities: ["mail-search"], requiredTools: ["mail_search"], requiredPromptFragments: [] }),
      nearestGenome(),
    );

    expect(proposed.capabilities).toEqual(["qa", "task-clarification", "mail-search"]);
    expect(proposed.tools).toEqual(["read", "mail_search"]);
    expect(proposed.promptFragments).toEqual(["general.md"]);
  });

  it("defaults to no additional tools/prompt fragments when the gap does not specify any", () => {
    const proposed = incubator.propose(
      { reason: "high_novelty", roleId: "novel-worker", missingCapabilities: ["novel-thing"] },
      nearestGenome(),
    );

    expect(proposed.tools).toEqual(["read"]);
    expect(proposed.promptFragments).toEqual(["general.md"]);
  });

  it("does not duplicate a capability/tool/prompt fragment the nearest genome already has", () => {
    const proposed = incubator.propose(
      gap({ missingCapabilities: ["qa", "mail-send"], requiredTools: ["read", "mail_send"] }),
      nearestGenome(),
    );

    expect(proposed.capabilities).toEqual(["qa", "task-clarification", "mail-send"]);
    expect(proposed.tools).toEqual(["read", "mail_send"]);
  });

  it("sets lifecycle to trial with a one-task-cycle TTL", () => {
    const proposed = incubator.propose(gap(), nearestGenome());

    expect(proposed.lifecycle.state).toBe("trial");
    expect(proposed.lifecycle.ttlTaskCycles).toBe(1);
  });

  it("carries over the nearest genome's maxTaskAgeSeconds (inherited, not invented)", () => {
    const proposed = incubator.propose(gap(), nearestGenome({ lifecycle: { state: "resident", maxTaskAgeSeconds: 900 } }));
    expect(proposed.lifecycle.maxTaskAgeSeconds).toBe(900);
  });

  it("records a non-empty birth reason and at least one death condition, and the result always validates", () => {
    const proposed = incubator.propose(gap(), nearestGenome());

    expect(proposed.birthReason).not.toBe("");
    expect(proposed.birthReason).toContain("missing_capability");
    expect(proposed.deathConditions.length).toBeGreaterThan(0);
    expect(() => validateGenome(proposed)).not.toThrow();
  });

  it("extends lineage with the nearest genome's own roleId", () => {
    const proposed = incubator.propose(gap(), nearestGenome());
    expect(proposed.lineage).toEqual(["general"]);
  });

  it("appends to an already-nonempty lineage rather than replacing it", () => {
    const proposed = incubator.propose(
      gap(),
      nearestGenome({ roleId: "office-worker", lineage: ["general"] }),
    );
    expect(proposed.lineage).toEqual(["general", "office-worker"]);
  });

  it("copies modelPolicy verbatim -- minimal mutation never changes model class or thinking level", () => {
    const proposed = incubator.propose(gap(), nearestGenome());
    expect(proposed.modelPolicy).toEqual({ preferredClass: "balanced", thinkingLevel: "medium" });
  });

  it("resets fitness to a fresh baseline for the brand-new genome", () => {
    const proposed = incubator.propose(
      gap(),
      nearestGenome({ fitness: { successes: 99, failures: 5, userCorrections: 2 } }),
    );
    expect(proposed.fitness).toEqual({ successes: 0, failures: 0, userCorrections: 0 });
  });

  it("never mutates the nearest genome it copies from", () => {
    const original = nearestGenome();
    const snapshot = JSON.parse(JSON.stringify(original)) as RoleGenome;

    incubator.propose(gap(), original);

    expect(original).toEqual(snapshot);
  });

  it("is pure -- identical inputs produce an identical genome", () => {
    const first = incubator.propose(gap(), nearestGenome());
    const second = incubator.propose(gap(), nearestGenome());
    expect(first).toEqual(second);
  });

  it.each(CAPABILITY_GAP_REASONS)("accepts every design-doc birth-condition reason (%s)", (reason) => {
    expect(() => incubator.propose(gap({ reason }), nearestGenome())).not.toThrow();
  });

  it("throws when the gap names no missing capability", () => {
    expect(() => incubator.propose(gap({ missingCapabilities: [] }), nearestGenome())).toThrow(
      InvalidCapabilityGapError,
    );
  });

  it("throws when the gap has no roleId", () => {
    expect(() => incubator.propose(gap({ roleId: "" }), nearestGenome())).toThrow(InvalidCapabilityGapError);
  });
});
