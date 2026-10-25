import { createServer } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  BACKEND_SERVICE,
  FRONTEND_SERVICE,
  SIDECAR_SERVICE,
  createMarcusDeviceStatusProvider,
  createMarcusServiceController,
  isPortOpen,
} from "../../src/tools/device-system.js";

describe("device status", () => {
  it("reports each of Marcus's services from a port probe, the sidecar always running", async () => {
    const provider = createMarcusDeviceStatusProvider({
      ports: { backend: 7860, frontend: 1420 },
      probe: async (port) => port === 7860,
      now: () => new Date("2026-10-25T00:00:00.000Z"),
    });

    const snapshot = await provider.snapshot();

    expect(snapshot.capturedAt).toBe("2026-10-25T00:00:00.000Z");
    expect(Object.fromEntries(snapshot.services.map((s) => [s.name, s.state]))).toEqual({
      [SIDECAR_SERVICE]: "running",
      [BACKEND_SERVICE]: "running",
      [FRONTEND_SERVICE]: "stopped",
    });
  });

  it("isPortOpen sees a real listener and a closed port", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    expect(await isPortOpen(port)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortOpen(port)).toBe(false);
  });
});

describe("service controller", () => {
  it("restarts the backend by running scripts/restart-backend.sh detached", async () => {
    const runScript = vi.fn();
    const controller = createMarcusServiceController({ repoRoot: "/repo", runScript });

    const result = await controller.apply({ service: BACKEND_SERVICE, action: "restart" });

    expect(runScript).toHaveBeenCalledWith("/repo/scripts/restart-backend.sh");
    expect(result.success).toBe(true);
  });

  it.each([
    [BACKEND_SERVICE, "stop"],
    [BACKEND_SERVICE, "shutdown"],
    [FRONTEND_SERVICE, "restart"],
    [SIDECAR_SERVICE, "restart"],
    ["sshd", "restart"],
  ] as const)("does nothing for %s %s and says so", async (service, action) => {
    const runScript = vi.fn();
    const controller = createMarcusServiceController({ repoRoot: "/repo", runScript });

    const result = await controller.apply({ service, action });

    expect(runScript).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
