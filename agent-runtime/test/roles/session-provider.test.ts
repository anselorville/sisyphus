/**
 * createDefaultPiSessionProvider()'s own wiring: does it actually resolve
 * each role's modelClass through the injected modelRouting/modelRuntime and
 * forward the concrete Model to createAgentSession()? session-manager.ts's
 * doc comment explicitly calls this out as untested by session-manager.test.ts
 * (which only exercises PiRoleSessionManager against a fake PiSessionProvider)
 * -- resolveRoleModel() itself is covered in isolation by model-routing.test.ts,
 * but nothing previously confirmed createDefaultPiSessionProvider() calls it
 * with the right arguments or reuses one ModelRuntime across roles.
 *
 * Mocks @earendil-works/pi-coding-agent entirely: this provider is
 * production-only wiring around the real SDK, so the point is to verify the
 * plumbing (what gets called, with what), never to exercise a live Pi
 * backend.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  modelRuntimeCreate: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeResourceLoader {
    constructor(_options: unknown) {}
    async reload(): Promise<void> {}
  }
  class FakeSettingsManager {
    static create(): FakeSettingsManager {
      return new FakeSettingsManager();
    }
  }
  class FakeSessionManager {
    static create(cwd: string, dir: string): { cwd: string; dir: string } {
      return { cwd, dir };
    }
  }
  class FakeModelRuntime {
    static create = mocks.modelRuntimeCreate;
  }

  return {
    createAgentSession: mocks.createAgentSession,
    DefaultResourceLoader: FakeResourceLoader,
    SettingsManager: FakeSettingsManager,
    SessionManager: FakeSessionManager,
    ModelRuntime: FakeModelRuntime,
    getAgentDir: (): string => "/fake/agent-dir",
  };
});

const { createDefaultPiSessionProvider } = await import("../../src/roles/session-manager.js");
const { UnresolvedRoleModelError } = await import("../../src/roles/model-routing.js");
import type { ModelCatalog } from "../../src/roles/model-routing.js";
import type { RoleManifest, RoleModelClassRouting } from "../../src/roles/types.js";

const ROUTING: RoleModelClassRouting = {
  fast: { provider: "deepseek", modelId: "deepseek-v4-flash" },
  balanced: { provider: "deepseek", modelId: "deepseek-v4-pro" },
  deep: { provider: "anthropic", modelId: "claude-opus-4-5" },
};

function manifest(overrides: Partial<RoleManifest> & Pick<RoleManifest, "id" | "modelClass">): RoleManifest {
  return {
    capabilities: [],
    tools: ["read"],
    promptPath: "resources/roles/general.md",
    thinkingLevel: "medium",
    lifecycle: "resident",
    ...overrides,
  };
}

function fakeCatalog(available: Record<string, string[]>): ModelCatalog {
  return {
    async getAvailable(providerId) {
      const ids = (providerId ? available[providerId] : undefined) ?? [];
      return ids.map((id) => ({ id, provider: providerId, name: id }) as never);
    },
  };
}

afterEach(() => {
  mocks.createAgentSession.mockReset();
  mocks.modelRuntimeCreate.mockReset();
});

describe("createDefaultPiSessionProvider", () => {
  it("resolves the role's modelClass through modelRouting and passes the concrete model to createAgentSession", async () => {
    mocks.createAgentSession.mockResolvedValue({ session: { fake: "session" } });
    const modelRuntime = fakeCatalog({ deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"] });

    const provider = createDefaultPiSessionProvider({
      modelRuntime: modelRuntime as never,
      modelRouting: ROUTING,
    });

    await provider(manifest({ id: "device", modelClass: "fast" }));

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    const call = mocks.createAgentSession.mock.calls[0]?.[0] as { model?: unknown };
    expect(call.model).toEqual({ id: "deepseek-v4-flash", provider: "deepseek", name: "deepseek-v4-flash" });
  });

  it("routes a different role's tier to a different model", async () => {
    mocks.createAgentSession.mockResolvedValue({ session: { fake: "session" } });
    const modelRuntime = fakeCatalog({ deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"] });

    const provider = createDefaultPiSessionProvider({
      modelRuntime: modelRuntime as never,
      modelRouting: ROUTING,
    });

    await provider(manifest({ id: "code", modelClass: "balanced" }));

    const call = mocks.createAgentSession.mock.calls[0]?.[0] as { model?: unknown };
    expect(call.model).toEqual({ id: "deepseek-v4-pro", provider: "deepseek", name: "deepseek-v4-pro" });
  });

  it("rejects, and never calls createAgentSession, when the role's routed model isn't available", async () => {
    const modelRuntime = fakeCatalog({ deepseek: ["deepseek-v4-flash"] });

    const provider = createDefaultPiSessionProvider({
      modelRuntime: modelRuntime as never,
      modelRouting: ROUTING,
    });

    await expect(provider(manifest({ id: "code", modelClass: "deep" }))).rejects.toThrow(UnresolvedRoleModelError);
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });

  it("builds the ModelRuntime lazily, once, and reuses it across every role", async () => {
    mocks.createAgentSession.mockResolvedValue({ session: { fake: "session" } });
    mocks.modelRuntimeCreate.mockResolvedValue(
      fakeCatalog({ deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"] }),
    );

    const provider = createDefaultPiSessionProvider({ modelRouting: ROUTING });

    expect(mocks.modelRuntimeCreate).not.toHaveBeenCalled();

    await provider(manifest({ id: "device", modelClass: "fast" }));
    await provider(manifest({ id: "code", modelClass: "balanced" }));

    expect(mocks.modelRuntimeCreate).toHaveBeenCalledTimes(1);
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
  });

  it("defaults modelRouting to config.modelClassRouting when none is injected", async () => {
    mocks.createAgentSession.mockResolvedValue({ session: { fake: "session" } });
    mocks.modelRuntimeCreate.mockResolvedValue(
      fakeCatalog({ deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"] }),
    );

    const provider = createDefaultPiSessionProvider();

    await provider(manifest({ id: "device", modelClass: "fast" }));

    const call = mocks.createAgentSession.mock.calls[0]?.[0] as { model?: unknown };
    expect(call.model).toEqual({ id: "deepseek-v4-flash", provider: "deepseek", name: "deepseek-v4-flash" });
  });
});
