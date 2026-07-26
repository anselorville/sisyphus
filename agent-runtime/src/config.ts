/**
 * Central runtime configuration for the agent-runtime sidecar.
 *
 * Values default to the constants fixed by the wire protocol spec and may be
 * overridden via environment variables for testing/operational tuning. All
 * env parsing happens once, at module load (a system boundary), so the rest
 * of the codebase can trust `config` without re-validating it.
 */

import { fileURLToPath } from "node:url";

import type { RoleModelClassRouting, RoleModelRef } from "./roles/types.js";

export interface AgentRuntimeConfig {
  /** Maximum allowed nesting depth of a RealtimeEvent's `payload`, counting the payload object itself as depth 0. */
  readonly maxPayloadDepth: number;
  /** Maximum allowed size, in bytes, of a RealtimeEvent once encoded as UTF-8 JSON. */
  readonly maxEventBytes: number;
  /** Default bounded capacity of an OutboundEventQueue. */
  readonly outboundQueueCapacity: number;
  /**
   * Port the sidecar's WebSocket server (../transport/websocket-server.ts,
   * 127.0.0.1 only) listens on. Matches app/config.py's AGENT_RUNTIME_URL
   * default of `ws://127.0.0.1:8765/events`.
   */
  readonly port: number;
  /**
   * Path to the sidecar's SQLite database file. Defaults to
   * `<package root>/data/agent-runtime.sqlite3`, resolved relative to this
   * module's own location (never `process.cwd()`) so it is stable no matter
   * where `node dist/index.js` is launched from -- mirrors
   * ../roles/manifests.ts's resolveRolePromptPath().
   */
  readonly dbPath: string;
  /** Total dollars the swarm's shared ApiBudgetLedger (../economy/api-budget.ts) may spend per provider per day. */
  readonly apiBudgetDailyLimitUsd: number;
  /** Slice of apiBudgetDailyLimitUsd ordinary workers can never draw on (../economy/api-budget.ts). */
  readonly apiBudgetVoiceReserveUsd: number;
  /**
   * Which concrete provider/model each RoleManifest.modelClass tier routes
   * to (see ./roles/model-routing.ts). Overridable per tier via
   * AGENT_RUNTIME_MODEL_FAST/BALANCED/DEEP ("<provider>:<modelId>", e.g.
   * "anthropic:claude-opus-4-5"). Defaults route every tier to whichever
   * DeepSeek model this environment already authenticates
   * (DEEPSEEK_API_KEY) -- the cheaper deepseek-v4-flash for "fast", the
   * fuller deepseek-v4-pro for "balanced"/"deep" -- so roles differentiate
   * by cost tier out of the box with zero extra config, and an operator
   * with other providers configured can repoint any tier without a code
   * change.
   */
  readonly modelClassRouting: RoleModelClassRouting;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`environment variable ${name} must be a positive integer, got: ${raw}`);
  }

  return parsed;
}

function readNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new RangeError(`environment variable ${name} must be a non-negative number, got: ${raw}`);
  }

  return parsed;
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

/** Parses "<provider>:<modelId>" into a RoleModelRef. Exported (unlike this file's other parse helpers) so its validation behavior gets direct unit test coverage without env-var stubbing gymnastics; parseModelRef() below is the env-reading wrapper `config` actually uses. */
export function parseModelRefValue(name: string, raw: string): RoleModelRef {
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    throw new RangeError(`environment variable ${name} must be "<provider>:<modelId>", got: ${raw}`);
  }
  return { provider: raw.slice(0, separatorIndex), modelId: raw.slice(separatorIndex + 1) };
}

function parseModelRef(name: string, fallback: RoleModelRef): RoleModelRef {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return parseModelRefValue(name, raw);
}

const DEFAULT_DB_PATH = fileURLToPath(new URL("../data/agent-runtime.sqlite3", import.meta.url));

const DEEPSEEK_FLASH: RoleModelRef = { provider: "deepseek", modelId: "deepseek-v4-flash" };
const DEEPSEEK_PRO: RoleModelRef = { provider: "deepseek", modelId: "deepseek-v4-pro" };

export const config: AgentRuntimeConfig = Object.freeze({
  maxPayloadDepth: readPositiveInt("AGENT_RUNTIME_MAX_PAYLOAD_DEPTH", 12),
  maxEventBytes: readPositiveInt("AGENT_RUNTIME_MAX_EVENT_BYTES", 64 * 1024),
  outboundQueueCapacity: readPositiveInt("AGENT_RUNTIME_OUTBOUND_QUEUE_CAPACITY", 1024),
  port: readPositiveInt("AGENT_RUNTIME_PORT", 8765),
  dbPath: readString("AGENT_RUNTIME_DB_PATH", DEFAULT_DB_PATH),
  apiBudgetDailyLimitUsd: readNonNegativeNumber("AGENT_RUNTIME_API_BUDGET_DAILY_LIMIT_USD", 20),
  apiBudgetVoiceReserveUsd: readNonNegativeNumber("AGENT_RUNTIME_API_BUDGET_VOICE_RESERVE_USD", 2),
  modelClassRouting: Object.freeze({
    fast: parseModelRef("AGENT_RUNTIME_MODEL_FAST", DEEPSEEK_FLASH),
    balanced: parseModelRef("AGENT_RUNTIME_MODEL_BALANCED", DEEPSEEK_PRO),
    deep: parseModelRef("AGENT_RUNTIME_MODEL_DEEP", DEEPSEEK_PRO),
  }),
});
