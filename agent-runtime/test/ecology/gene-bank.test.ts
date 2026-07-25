import { describe, expect, it } from "vitest";

import { GeneBank, InvalidGenomeError, validateGenome } from "../../src/ecology/gene-bank.js";
import type { RoleGenome } from "../../src/ecology/gene-bank.js";

function genome(overrides: Partial<RoleGenome> = {}): RoleGenome {
  return {
    roleId: "mail-worker",
    lineage: ["general"],
    capabilities: ["mail-search", "mail-read", "mail-send"],
    tools: ["mail_search", "mail_read", "mail_send"],
    promptFragments: ["mail-worker.md"],
    modelPolicy: { preferredClass: "fast", thinkingLevel: "low" },
    birthReason: "first_release_baseline",
    deathConditions: ["two_consecutive_task_failures"],
    lifecycle: { state: "resident", maxTaskAgeSeconds: 1800 },
    fitness: { successes: 0, failures: 0, userCorrections: 0 },
    ...overrides,
  };
}

describe("Role Genome lifecycle (Step 1 mandated test)", () => {
  const baseGenome = genome();

  it("requires a birth reason and death condition", () => {
    expect(() =>
      validateGenome({
        ...baseGenome,
        birthReason: "",
        deathConditions: [],
      }),
    ).toThrow(/birth reason|death condition/);
  });

  it("rejects an empty birth reason on its own", () => {
    expect(() => validateGenome({ ...baseGenome, birthReason: "" })).toThrow(/birth reason/);
    expect(() => validateGenome({ ...baseGenome, birthReason: "   " })).toThrow(/birth reason/);
  });

  it("rejects an empty death-conditions list on its own", () => {
    expect(() => validateGenome({ ...baseGenome, deathConditions: [] })).toThrow(/death condition/);
  });

  it("rejects a genome with no declared capabilities", () => {
    expect(() => validateGenome({ ...baseGenome, capabilities: [] })).toThrow(InvalidGenomeError);
  });

  it("rejects an empty roleId", () => {
    expect(() => validateGenome({ ...baseGenome, roleId: "" })).toThrow(InvalidGenomeError);
  });

  it("accepts a well-formed genome and returns it unchanged", () => {
    expect(validateGenome(baseGenome)).toEqual(baseGenome);
  });
});

describe("GeneBank", () => {
  it("stores and retrieves a genome by roleId", () => {
    const bank = new GeneBank();
    bank.store(genome());

    expect(bank.get("mail-worker")).toEqual(genome());
    expect(bank.has("mail-worker")).toBe(true);
    expect(bank.has("ghost")).toBe(false);
  });

  it("returns undefined for a roleId that was never stored", () => {
    expect(new GeneBank().get("ghost")).toBeUndefined();
  });

  it("never accepts an invalid genome -- delegates to validateGenome", () => {
    const bank = new GeneBank();
    expect(() => bank.store(genome({ birthReason: "" }))).toThrow(InvalidGenomeError);
    expect(bank.has("mail-worker")).toBe(false);
  });

  it("replaces a previously-stored genome under the same roleId", () => {
    const bank = new GeneBank();
    bank.store(genome({ fitness: { successes: 0, failures: 0, userCorrections: 0 } }));
    bank.store(genome({ fitness: { successes: 3, failures: 0, userCorrections: 0 } }));

    expect(bank.list()).toHaveLength(1);
    expect(bank.get("mail-worker")?.fitness.successes).toBe(3);
  });

  it("lists every stored genome in insertion order", () => {
    const bank = new GeneBank();
    bank.store(genome({ roleId: "mail-worker" }));
    bank.store(genome({ roleId: "code-worker", lineage: ["general"], capabilities: ["code-editing"] }));

    expect(bank.list().map((g) => g.roleId)).toEqual(["mail-worker", "code-worker"]);
  });

  it("returns an empty list for a brand-new bank", () => {
    expect(new GeneBank().list()).toEqual([]);
  });

  it("lists genomes descended from a given lineage ancestor", () => {
    const bank = new GeneBank();
    bank.store(genome({ roleId: "mail-worker", lineage: ["general"] }));
    bank.store(genome({ roleId: "web-worker", lineage: ["general"], capabilities: ["web-search"] }));
    bank.store(genome({ roleId: "root", lineage: [] }));

    expect(bank.listByLineage("general").map((g) => g.roleId)).toEqual(["mail-worker", "web-worker"]);
    expect(bank.listByLineage("root")).toEqual([]);
  });

  it("lists genomes by declared capability", () => {
    const bank = new GeneBank();
    bank.store(genome({ roleId: "mail-worker", capabilities: ["mail-search", "mail-send"] }));
    bank.store(genome({ roleId: "web-worker", lineage: ["general"], capabilities: ["web-search"] }));

    expect(bank.listByCapability("mail-send").map((g) => g.roleId)).toEqual(["mail-worker"]);
    expect(bank.listByCapability("nonexistent-capability")).toEqual([]);
  });
});
