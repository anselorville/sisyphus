/**
 * Device Steward's two tools: device_status() (always read-only) and a
 * controlled service_action(service, action).
 *
 * service_action's classification follows the design doc's own worked
 * example, and DiplomacyOfficer's already-built rules decide the rest (this
 * module does not reimplement or shortcut them, per the same principle as
 * the mail adapter's bulk-vs-single-send distinction):
 *   - Restarting THIS APP'S OWN service is `operation: "system"` with
 *     `threatensAvailability: false` -- DiplomacyOfficer's ordinary-default
 *     rule (9.2) resolves that to ALLOW_LOGGED (autonomous, but logged).
 *   - Anything else service_action can express -- starting/stopping the
 *     app's own service, or any action at all against a service this module
 *     was not told is "our own" (a system-level service, by construction) --
 *     is marked `threatensAvailability: true`, which DiplomacyOfficer's
 *     fatal-first rule (9.1 judge factor 5) always elevates, regardless of
 *     operation type. A dedicated "shutdown" action and any network-core
 *     config change both fall under this same always-elevate case, since
 *     neither can ever be "restart this app's own service".
 * This keeps the module's own logic to "which one narrow case is safe",
 * rather than re-deriving DiplomacyOfficer's risk matrix here.
 */

import type { ActionEnvelope } from "./diplomacy-officer.js";

/** Structural seam CapabilityGateway satisfies as-is (mirrors CapabilityGatewayLike in ./web-tools.ts and ./mail/agently-mail.ts). */
export interface CapabilityGatewayLike {
  execute<T>(envelope: ActionEnvelope, operation: () => Promise<T>): Promise<T>;
}

export interface ToolCallContext {
  readonly taskId?: string;
  readonly roleId?: string;
}

const DEFAULT_ROLE_ID = "device";
const DEFAULT_TASK_ID = "adhoc";

export type ServiceState = "running" | "stopped" | "degraded" | "unknown";

export interface ServiceStatus {
  readonly name: string;
  readonly state: ServiceState;
  readonly detail?: string;
}

export interface DeviceStatusSnapshot {
  readonly services: readonly ServiceStatus[];
  readonly capturedAt: string;
}

export type ServiceActionKind = "start" | "stop" | "restart" | "shutdown";

export interface ServiceActionRequest {
  readonly service: string;
  readonly action: ServiceActionKind;
}

export interface ServiceActionResult {
  readonly service: string;
  readonly action: ServiceActionKind;
  readonly success: boolean;
  readonly detail: string | undefined;
}

/**
 * Real system-facing status source (e.g. shelling out to `systemctl`,
 * reading `/proc`). Not implemented in this task -- production wiring
 * supplies a real one; this module only defines the seam and the
 * gateway/classification logic around it.
 */
export interface DeviceStatusProvider {
  snapshot(): Promise<DeviceStatusSnapshot>;
}

/** Real system-facing service controller (e.g. `systemctl start/stop/restart`). Same "seam only, no real implementation here" note as DeviceStatusProvider. */
export interface ServiceController {
  apply(request: ServiceActionRequest): Promise<ServiceActionResult>;
}

export interface DeviceToolsOptions {
  readonly gateway: CapabilityGatewayLike;
  readonly statusProvider: DeviceStatusProvider;
  readonly serviceController: ServiceController;
  /** Service name(s) considered "this app's own service" -- the one case service_action can run autonomously. Everything else always elevates (see the module doc comment). */
  readonly ownServiceNames: readonly string[];
}

function isOwnServiceRestart(request: ServiceActionRequest, ownServiceNames: ReadonlySet<string>): boolean {
  return request.action === "restart" && ownServiceNames.has(request.service);
}

/** Device Steward's tool surface. Read-only by default; service_action is the only mutating tool, and only ever autonomous for the one narrow "restart our own service" case (see the module doc comment). */
export class DeviceTools {
  private readonly gateway: CapabilityGatewayLike;
  private readonly statusProvider: DeviceStatusProvider;
  private readonly serviceController: ServiceController;
  private readonly ownServiceNames: ReadonlySet<string>;

  constructor(options: DeviceToolsOptions) {
    this.gateway = options.gateway;
    this.statusProvider = options.statusProvider;
    this.serviceController = options.serviceController;
    this.ownServiceNames = new Set(options.ownServiceNames);
  }

  async device_status(context?: ToolCallContext): Promise<DeviceStatusSnapshot> {
    const envelope: ActionEnvelope = {
      taskId: context?.taskId ?? DEFAULT_TASK_ID,
      roleId: context?.roleId ?? DEFAULT_ROLE_ID,
      toolName: "device_status",
      targetSummary: "device status",
      reversible: true,
      affectedObjects: 1,
      externalAudience: 0,
      sensitiveData: false,
      threatensAvailability: false,
      operation: "read",
    };
    return this.gateway.execute(envelope, () => this.statusProvider.snapshot());
  }

  async service_action(request: ServiceActionRequest, context?: ToolCallContext): Promise<ServiceActionResult> {
    const ownRestart = isOwnServiceRestart(request, this.ownServiceNames);
    const envelope: ActionEnvelope = {
      taskId: context?.taskId ?? DEFAULT_TASK_ID,
      roleId: context?.roleId ?? DEFAULT_ROLE_ID,
      toolName: "service_action",
      targetSummary: `${request.action} service "${request.service}"`,
      reversible: ownRestart,
      affectedObjects: 1,
      externalAudience: 0,
      sensitiveData: false,
      // Only restarting the app's own service is safe to run unattended;
      // every other service/action combination -- system-level services,
      // shutdown, network-core config -- threatens availability by
      // construction (see the module doc comment).
      threatensAvailability: !ownRestart,
      operation: "system",
    };
    return this.gateway.execute(envelope, () => this.serviceController.apply(request));
  }
}
