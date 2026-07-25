/**
 * Central runtime configuration for the agent-runtime sidecar.
 *
 * Values default to the constants fixed by the wire protocol spec and may be
 * overridden via environment variables for testing/operational tuning. All
 * env parsing happens once, at module load (a system boundary), so the rest
 * of the codebase can trust `config` without re-validating it.
 */

export interface AgentRuntimeConfig {
  /** Maximum allowed nesting depth of a RealtimeEvent's `payload`, counting the payload object itself as depth 0. */
  readonly maxPayloadDepth: number;
  /** Maximum allowed size, in bytes, of a RealtimeEvent once encoded as UTF-8 JSON. */
  readonly maxEventBytes: number;
  /** Default bounded capacity of an OutboundEventQueue. */
  readonly outboundQueueCapacity: number;
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

export const config: AgentRuntimeConfig = Object.freeze({
  maxPayloadDepth: readPositiveInt("AGENT_RUNTIME_MAX_PAYLOAD_DEPTH", 12),
  maxEventBytes: readPositiveInt("AGENT_RUNTIME_MAX_EVENT_BYTES", 64 * 1024),
  outboundQueueCapacity: readPositiveInt("AGENT_RUNTIME_OUTBOUND_QUEUE_CAPACITY", 1024),
});
