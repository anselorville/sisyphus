/**
 * Real implementations of the Device Steward's two seams (device-tools.ts):
 * what is running, and the one service action Marcus may take on itself.
 *
 * Scope is deliberately Marcus's own three processes -- the sidecar, the
 * Python backend (media plane) and the frontend -- not the operating system.
 * "Restart this app's own service" is the one autonomous case the design
 * allows; there is no systemctl/launchctl in here, so even an approved
 * request for some other service has nothing to run and is reported as
 * unsupported rather than improvised.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";

import type {
  DeviceStatusProvider,
  DeviceStatusSnapshot,
  ServiceActionRequest,
  ServiceActionResult,
  ServiceController,
  ServiceStatus,
} from "./device-tools.js";

export const SIDECAR_SERVICE = "marcus-sidecar";
export const BACKEND_SERVICE = "marcus-backend";
export const FRONTEND_SERVICE = "marcus-frontend";

/** The services `service_action` may touch on its own authority (restart only; see the module comment). */
export const OWN_SERVICE_NAMES: readonly string[] = [BACKEND_SERVICE];

export interface MarcusPorts {
  readonly backend: number;
  readonly frontend: number;
}

export const DEFAULT_PORTS: MarcusPorts = { backend: 7860, frontend: 1420 };

/** Whether something accepts TCP connections on `port`, checking IPv4 then IPv6 loopback (Vite binds ::1 only). */
export async function isPortOpen(port: number, timeoutMs = 400): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const done = (value: boolean): void => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
    if (open) return true;
  }
  return false;
}

export interface MarcusDeviceStatusOptions {
  readonly ports?: MarcusPorts;
  readonly probe?: (port: number) => Promise<boolean>;
  readonly now?: () => Date;
}

export function createMarcusDeviceStatusProvider(options: MarcusDeviceStatusOptions = {}): DeviceStatusProvider {
  const ports = options.ports ?? DEFAULT_PORTS;
  const probe = options.probe ?? isPortOpen;
  const now = options.now ?? ((): Date => new Date());
  return {
    async snapshot(): Promise<DeviceStatusSnapshot> {
      const [backendUp, frontendUp] = await Promise.all([probe(ports.backend), probe(ports.frontend)]);
      const services: ServiceStatus[] = [
        // This very process answered, so the sidecar is by definition running.
        { name: SIDECAR_SERVICE, state: "running", detail: "answering this request" },
        { name: BACKEND_SERVICE, state: backendUp ? "running" : "stopped", detail: `port ${ports.backend}` },
        { name: FRONTEND_SERVICE, state: frontendUp ? "running" : "stopped", detail: `port ${ports.frontend}` },
      ];
      return { services, capturedAt: now().toISOString() };
    },
  };
}

export type ScriptRunner = (scriptPath: string) => void;

/** Starts a script fully detached, so it survives (and is not blocked by) the process it restarts. */
function spawnDetached(scriptPath: string): void {
  const child = spawn("bash", [scriptPath], { detached: true, stdio: "ignore" });
  child.unref();
}

export interface MarcusServiceControllerOptions {
  /** Repository root (where scripts/ lives). */
  readonly repoRoot: string;
  readonly runScript?: ScriptRunner;
}

export function createMarcusServiceController(options: MarcusServiceControllerOptions): ServiceController {
  const runScript = options.runScript ?? spawnDetached;
  return {
    async apply(request: ServiceActionRequest): Promise<ServiceActionResult> {
      const result = (success: boolean, detail: string): ServiceActionResult => ({
        service: request.service,
        action: request.action,
        success,
        detail,
      });
      if (request.service === BACKEND_SERVICE && request.action === "restart") {
        runScript(join(options.repoRoot, "scripts", "restart-backend.sh"));
        return result(true, "restart started; the voice connection drops and needs to be reconnected in a few seconds");
      }
      if (request.service === SIDECAR_SERVICE && request.action === "restart") {
        return result(false, "the sidecar cannot restart itself from inside a task; run scripts/start.sh from a terminal");
      }
      return result(false, `${request.action} of "${request.service}" is not supported: only restarting ${BACKEND_SERVICE} is wired up`);
    },
  };
}
