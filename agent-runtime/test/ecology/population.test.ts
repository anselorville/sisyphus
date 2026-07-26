import { describe, expect, it } from "vitest";

import { PopulationCapExceededError, PopulationRegistry } from "../../src/ecology/population.js";

describe("PopulationRegistry.hatch", () => {
  it("hatches a new role into the active population", () => {
    const registry = new PopulationRegistry({ activeCap: 4, isolationCap: 1 });
    const member = registry.hatch("code");

    expect(member).toEqual({ roleId: "code", lifecycle: "resident", status: "active" });
    expect(registry.activeCount()).toBe(1);
  });

  it("is idempotent for a role that is already active", () => {
    const registry = new PopulationRegistry({ activeCap: 4 });
    registry.hatch("code");
    registry.hatch("code");

    expect(registry.activeCount()).toBe(1);
  });

  it("throws once the ordinary population cap is reached", () => {
    const registry = new PopulationRegistry({ activeCap: 2 });
    registry.hatch("a");
    registry.hatch("b");

    expect(() => registry.hatch("c")).toThrow(PopulationCapExceededError);
    expect(registry.activeCount()).toBe(2);
  });

  it("tracks isolated-lifecycle roles against a separate isolation cap", () => {
    const registry = new PopulationRegistry({ activeCap: 4, isolationCap: 1 });
    registry.hatch("sandboxed-1", "isolated");

    expect(() => registry.hatch("sandboxed-2", "isolated")).toThrow(PopulationCapExceededError);
    // Ordinary cap is untouched by isolated hatches.
    expect(registry.hatch("code")).toEqual({ roleId: "code", lifecycle: "resident", status: "active" });
  });

  it("defaults to activeCap=4 and isolationCap=1 when not configured", () => {
    const registry = new PopulationRegistry();
    expect(registry.activeCap).toBe(4);
    expect(registry.isolationCap).toBe(1);
  });
});

describe("PopulationRegistry.sleep", () => {
  it("moves an active role to sleeping without forgetting it", () => {
    const registry = new PopulationRegistry({ activeCap: 4 });
    registry.hatch("code");
    registry.sleep("code");

    expect(registry.activeCount()).toBe(0);
    expect(registry.list()).toContainEqual({ roleId: "code", lifecycle: "resident", status: "sleeping" });
  });

  it("frees an active-cap slot for a new hatch", () => {
    const registry = new PopulationRegistry({ activeCap: 1 });
    registry.hatch("a");
    registry.sleep("a");

    expect(() => registry.hatch("b")).not.toThrow();
  });

  it("a sleeping role can hatch() again later", () => {
    const registry = new PopulationRegistry({ activeCap: 4 });
    registry.hatch("code");
    registry.sleep("code");

    expect(registry.hatch("code")).toEqual({ roleId: "code", lifecycle: "resident", status: "active" });
  });

  it("is a harmless no-op for an unknown role", () => {
    const registry = new PopulationRegistry();
    expect(() => registry.sleep("ghost")).not.toThrow();
    expect(registry.list()).toEqual([]);
  });
});

describe("PopulationRegistry.retire", () => {
  it("permanently removes a role from the active count", () => {
    const registry = new PopulationRegistry({ activeCap: 4 });
    registry.hatch("code");
    registry.retire("code");

    expect(registry.activeCount()).toBe(0);
    expect(registry.list()).toContainEqual({ roleId: "code", lifecycle: "resident", status: "retired" });
  });

  it("is a harmless no-op for an unknown role", () => {
    const registry = new PopulationRegistry();
    expect(() => registry.retire("ghost")).not.toThrow();
  });
});

describe("PopulationRegistry.list", () => {
  it("lists every role this registry has ever hatched, including sleeping/retired ones", () => {
    const registry = new PopulationRegistry({ activeCap: 4 });
    registry.hatch("code");
    registry.hatch("mail");
    registry.sleep("mail");

    expect(registry.list()).toEqual([
      { roleId: "code", lifecycle: "resident", status: "active" },
      { roleId: "mail", lifecycle: "resident", status: "sleeping" },
    ]);
  });

  it("returns an empty list for a brand-new registry", () => {
    expect(new PopulationRegistry().list()).toEqual([]);
  });
});
