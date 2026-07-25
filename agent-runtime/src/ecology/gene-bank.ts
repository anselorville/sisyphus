/**
 * Role Genome: the persisted shape of a role definition the swarm can
 * hatch/incubate/retire, and the Gene Bank that stores validated genomes --
 * design doc section 8.2 (Role Genome) and 12.3 (Gene Bank storage).
 *
 * Reconciling the design doc's illustrative JSON (section 8.2, snake_case,
 * documentation prose rather than a literal wire format) with this
 * package's TypeScript convention and this task's own mandated test:
 *   - every field is camelCase (role_id -> roleId, prompt_fragments ->
 *     promptFragments, model_policy.preferred_class -> modelPolicy.preferredClass,
 *     birth_reason -> birthReason, max_task_age_seconds -> maxTaskAgeSeconds,
 *     user_corrections -> userCorrections);
 *   - `deathConditions: readonly string[]` is added -- the design doc's
 *     illustration does not show it, but this task's own mandated test
 *     (validateGenome() rejecting an empty birthReason/deathConditions
 *     pair) requires it, and the global constraint is explicit: a role can
 *     never be born without both a non-empty birth reason and at least one
 *     death condition. The concrete test wins over the older illustration.
 *
 * Persistence choice for this task: a plain in-memory Map, mirroring
 * ./population.ts's PopulationRegistry (also in-memory bookkeeping for
 * this same task generation) and ../roles/registry.ts's
 * RoleManifestRegistry -- both explicitly leave real persistence (SQLite,
 * per design doc section 12's "sidecar 独占 SQLite 写入权") to a later
 * wiring task. If/when that lands, the natural seam is an injectable
 * store interface this class delegates reads/writes to (mirroring
 * PiSessionProvider/AgentlyCliTransport's own injectable-seam pattern
 * elsewhere in this codebase) -- deliberately not built here since nothing
 * in this task's spec requires it yet ("no SQLite wiring required unless
 * you want to sketch the seam").
 */

import type { RoleModelClass, RoleThinkingLevel } from "../roles/types.js";

export type GenomeLifecycleState = "trial" | "resident" | "dormant" | "retired";

export interface GenomeLifecycle {
  readonly state: GenomeLifecycleState;
  /** Wall-clock cap (seconds) on a single task run under this genome -- design doc's max_task_age_seconds. Optional; meaningful once the role actually runs tasks. */
  readonly maxTaskAgeSeconds?: number;
  /** Trial-only: task cycles this genome may run before its trial TTL expires and it must be judged (promoted/retired). Set by RoleIncubator.propose() (see ./role-incubator.ts); absent once a genome is no longer on trial. */
  readonly ttlTaskCycles?: number;
}

export interface GenomeModelPolicy {
  readonly preferredClass: RoleModelClass;
  readonly thinkingLevel: RoleThinkingLevel;
}

export interface GenomeFitness {
  readonly successes: number;
  readonly failures: number;
  readonly userCorrections: number;
}

/** One role's persisted genetic definition -- see the module doc comment for the exact reconciliation with the design doc's illustrative JSON. */
export interface RoleGenome {
  readonly roleId: string;
  /** Ancestor role ids, oldest-first. Empty for a foundational genome with no parent (e.g. the General Worker). */
  readonly lineage: readonly string[];
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly promptFragments: readonly string[];
  readonly modelPolicy: GenomeModelPolicy;
  /** Why this genome was created. Never empty -- see validateGenome(). */
  readonly birthReason: string;
  /** Conditions under which this genome stops being trusted/active (e.g. "two_consecutive_task_failures"). Never empty -- see validateGenome(). */
  readonly deathConditions: readonly string[];
  readonly lifecycle: GenomeLifecycle;
  readonly fitness: GenomeFitness;
}

/** Thrown by validateGenome()/GeneBank.store() for a structurally-invalid genome. Message always names which requirement failed. */
export class InvalidGenomeError extends Error {
  constructor(roleId: string, reason: string) {
    super(`role genome "${roleId}" is invalid: ${reason}`);
    this.name = "InvalidGenomeError";
  }
}

/**
 * Validates the global birth/death and structural invariants every
 * RoleGenome must satisfy, throwing InvalidGenomeError on the first
 * violation found. Returns `genome` unchanged so call sites can use it
 * inline (e.g. `store(validateGenome(genome))`) -- see GeneBank.store() and
 * RoleIncubator.propose(), which both delegate here rather than
 * re-implementing any of these checks.
 */
export function validateGenome(genome: RoleGenome): RoleGenome {
  if (genome.roleId.trim() === "") {
    throw new InvalidGenomeError(genome.roleId, "roleId must be non-empty");
  }
  if (genome.capabilities.length === 0) {
    throw new InvalidGenomeError(genome.roleId, "must declare at least one capability");
  }
  if (genome.birthReason.trim() === "") {
    throw new InvalidGenomeError(genome.roleId, "requires a non-empty birth reason");
  }
  if (genome.deathConditions.length === 0) {
    throw new InvalidGenomeError(genome.roleId, "requires at least one death condition");
  }
  return genome;
}

/**
 * In-memory Gene Bank: stores validated RoleGenomes keyed by roleId (see
 * the module doc comment for the persistence choice). store() always
 * delegates to validateGenome() first -- a genome that fails validation is
 * never recorded, and replaces any previous genome under the same roleId
 * otherwise, mirroring ../roles/registry.ts's RoleManifestRegistry.register().
 */
export class GeneBank {
  private readonly genomes = new Map<string, RoleGenome>();

  /** Validates and stores `genome`, replacing any previous genome under the same roleId. Throws InvalidGenomeError (and stores nothing) if validation fails. Returns the stored (frozen) genome. */
  store(genome: RoleGenome): RoleGenome {
    const validated = validateGenome(genome);
    const stored = Object.freeze({ ...validated });
    this.genomes.set(stored.roleId, stored);
    return stored;
  }

  get(roleId: string): RoleGenome | undefined {
    return this.genomes.get(roleId);
  }

  has(roleId: string): boolean {
    return this.genomes.has(roleId);
  }

  /** Every stored genome, insertion order. */
  list(): readonly RoleGenome[] {
    return [...this.genomes.values()];
  }

  /** Genomes whose lineage includes `ancestorRoleId` -- i.e. descendants of that role, not the ancestor itself. */
  listByLineage(ancestorRoleId: string): readonly RoleGenome[] {
    return this.list().filter((genome) => genome.lineage.includes(ancestorRoleId));
  }

  /** Genomes that declare `capability`. */
  listByCapability(capability: string): readonly RoleGenome[] {
    return this.list().filter((genome) => genome.capabilities.includes(capability));
  }
}
