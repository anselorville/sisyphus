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

describe("PopulationRegistry.get", () => {
  it("returns current bookkeeping for a known role", () => {
    const registry = new PopulationRegistry();
    registry.hatch("mail");
    expect(registry.get("mail")).toEqual({ roleId: "mail", lifecycle: "resident", status: "active" });
  });

  it("returns undefined for a role that has never been hatched", () => {
    expect(new PopulationRegistry().get("ghost")).toBeUndefined();
  });
});

describe("PopulationRegistry.wake (Roadmap #5)", () => {
  it("re-activates a sleeping role, preserving its original lifecycle", () => {
    const registry = new PopulationRegistry();
    registry.hatch("device", "isolated");
    registry.sleep("device");

    const woken = registry.wake("device");

    expect(woken).toEqual({ roleId: "device", lifecycle: "isolated", status: "active" });
    expect(registry.get("device")?.status).toBe("active");
  });

  it("frees the sleeping slot and re-consumes an active slot -- still respects activeCap", () => {
    const registry = new PopulationRegistry({ activeCap: 1 });
    registry.hatch("mail");
    registry.sleep("mail");
    registry.hatch("code"); // takes the one active slot mail vacated

    expect(() => registry.wake("mail")).toThrow(/cap/);
  });

  it("is a harmless no-op (returns undefined) for an unknown role", () => {
    const registry = new PopulationRegistry();
    expect(registry.wake("ghost")).toBeUndefined();
  });

  it("is a harmless no-op for an already-active role", () => {
    const registry = new PopulationRegistry();
    registry.hatch("mail");
    expect(registry.wake("mail")).toBeUndefined();
    expect(registry.get("mail")?.status).toBe("active");
  });

  it("is a harmless no-op for a retired role -- retirement never wakes", () => {
    const registry = new PopulationRegistry();
    registry.hatch("mail");
    registry.retire("mail");
    expect(registry.wake("mail")).toBeUndefined();
    expect(registry.get("mail")?.status).toBe("retired");
  });
});
