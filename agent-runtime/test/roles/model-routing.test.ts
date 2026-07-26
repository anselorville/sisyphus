import { describe, expect, it } from "vitest";

import { resolveRoleModel, UnresolvedRoleModelError, type ModelCatalog } from "../../src/roles/model-routing.js";
import type { RoleModelClassRouting } from "../../src/roles/types.js";

const ROUTING: RoleModelClassRouting = {
  fast: { provider: "deepseek", modelId: "deepseek-v4-flash" },
  balanced: { provider: "deepseek", modelId: "deepseek-v4-pro" },
  deep: { provider: "anthropic", modelId: "claude-opus-4-5" },
};

function fakeCatalog(available: Record<string, string[]>): ModelCatalog {
  return {
    async getAvailable(providerId) {
      const ids = (providerId ? available[providerId] : undefined) ?? [];
      return ids.map((id) => ({ id, provider: providerId, name: id }) as never);
    },
  };
}

describe("resolveRoleModel", () => {
  it("resolves a tier to the model its routing names, once the catalog confirms it's available", async () => {
    const catalog = fakeCatalog({ deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"] });

    const model = await resolveRoleModel(catalog, "device", "fast", ROUTING);

    expect(model.id).toBe("deepseek-v4-flash");
  });

  it("resolves a different tier to a different model, so two roles on different tiers never collapse onto the same model", async () => {
    const catalog = fakeCatalog({
      deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
      anthropic: ["claude-opus-4-5"],
    });

    const fast = await resolveRoleModel(catalog, "device", "fast", ROUTING);
    const deep = await resolveRoleModel(catalog, "code", "deep", ROUTING);

    expect(fast.id).not.toBe(deep.id);
  });

  it("throws UnresolvedRoleModelError when the routed model id isn't in the catalog's available list", async () => {
    const catalog = fakeCatalog({ deepseek: ["deepseek-v4-flash"] });

    await expect(resolveRoleModel(catalog, "code", "balanced", ROUTING)).rejects.toThrow(UnresolvedRoleModelError);
  });

  it("throws UnresolvedRoleModelError when the routed provider has no configured auth at all", async () => {
    const catalog = fakeCatalog({ deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"] });

    await expect(resolveRoleModel(catalog, "code", "deep", ROUTING)).rejects.toThrow(UnresolvedRoleModelError);
  });

  it("names the offending roleId, modelClass, and provider:modelId in the error so it's actionable", async () => {
    const catalog = fakeCatalog({});

    await expect(resolveRoleModel(catalog, "mail", "balanced", ROUTING)).rejects.toThrow(
      /mail.*balanced.*deepseek:deepseek-v4-pro/,
    );
  });
});
