import { describe, expect, it } from "vitest";

import { CapabilityGateway, ElevationRequiredError } from "../../src/tools/capability-gateway.js";
import {
  DeviceTools,
  type DeviceStatusProvider,
  type DeviceStatusSnapshot,
  type ServiceActionRequest,
  type ServiceActionResult,
  type ServiceController,
} from "../../src/tools/device-tools.js";
import { DiplomacyOfficer } from "../../src/tools/diplomacy-officer.js";

function makeStatusProvider(snapshot: DeviceStatusSnapshot): DeviceStatusProvider {
  return { snapshot: async () => snapshot };
}

class RecordingServiceController implements ServiceController {
  readonly calls: ServiceActionRequest[] = [];

  async apply(request: ServiceActionRequest): Promise<ServiceActionResult> {
    this.calls.push(request);
    return { service: request.service, action: request.action, success: true, detail: undefined };
  }
}

function makeGateway(): CapabilityGateway {
  // Real DiplomacyOfficer + real CapabilityGateway, exactly like the mail
  // adapter's tests: this proves service_action's own/other-service
  // distinction actually resolves through Task 11's existing rules
  // (threatensAvailability -> always ELEVATE), not a fake that assumes it.
  return new CapabilityGateway({ officer: new DiplomacyOfficer() });
}

describe("DeviceTools.device_status", () => {
  it("returns the status provider's snapshot, read-only, through the gateway", async () => {
    const snapshot: DeviceStatusSnapshot = {
      services: [{ name: "sisyphus-backend", state: "running" }],
      capturedAt: "2026-07-25T00:00:00.000Z",
    };
    const tools = new DeviceTools({
      gateway: makeGateway(),
      statusProvider: makeStatusProvider(snapshot),
      serviceController: new RecordingServiceController(),
      ownServiceNames: ["sisyphus-backend"],
    });

    await expect(tools.device_status()).resolves.toEqual(snapshot);
  });
});

describe("DeviceTools.service_action", () => {
  it("restarting the app's own service runs autonomously (ALLOW_LOGGED) and logs the action", async () => {
    const gateway = makeGateway();
    const controller = new RecordingServiceController();
    const tools = new DeviceTools({
      gateway,
      statusProvider: makeStatusProvider({ services: [], capturedAt: "now" }),
      serviceController: controller,
      ownServiceNames: ["sisyphus-backend"],
    });

    const result = await tools.service_action({ service: "sisyphus-backend", action: "restart" });

    expect(result.success).toBe(true);
    expect(controller.calls).toEqual([{ service: "sisyphus-backend", action: "restart" }]);
    expect(gateway.logEntries).toHaveLength(1);
    expect(gateway.logEntries[0]?.decision).toBe("ALLOW_LOGGED");
  });

  it("restarting a different (non-own) service elevates and never calls the controller", async () => {
    const controller = new RecordingServiceController();
    const tools = new DeviceTools({
      gateway: makeGateway(),
      statusProvider: makeStatusProvider({ services: [], capturedAt: "now" }),
      serviceController: controller,
      ownServiceNames: ["sisyphus-backend"],
    });

    await expect(tools.service_action({ service: "network-manager", action: "restart" })).rejects.toBeInstanceOf(
      ElevationRequiredError,
    );
    expect(controller.calls).toHaveLength(0);
  });

  it.each(["start", "stop", "shutdown"] as const)(
    "%s on the app's own service still elevates -- only 'restart' is the safe case",
    async (action) => {
      const controller = new RecordingServiceController();
      const tools = new DeviceTools({
        gateway: makeGateway(),
        statusProvider: makeStatusProvider({ services: [], capturedAt: "now" }),
        serviceController: controller,
        ownServiceNames: ["sisyphus-backend"],
      });

      await expect(tools.service_action({ service: "sisyphus-backend", action })).rejects.toBeInstanceOf(
        ElevationRequiredError,
      );
      expect(controller.calls).toHaveLength(0);
    },
  );

  it("shutdown on any service always elevates, regardless of ownServiceNames", async () => {
    const controller = new RecordingServiceController();
    const tools = new DeviceTools({
      gateway: makeGateway(),
      statusProvider: makeStatusProvider({ services: [], capturedAt: "now" }),
      serviceController: controller,
      ownServiceNames: ["sisyphus-backend"],
    });

    await expect(
      tools.service_action({ service: "sisyphus-backend", action: "shutdown" }),
    ).rejects.toBeInstanceOf(ElevationRequiredError);
    expect(controller.calls).toHaveLength(0);
  });
});
