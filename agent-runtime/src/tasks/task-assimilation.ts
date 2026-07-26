/**
 * Task Assimilation: the "task ends -> assimilate" assembly layer named in
 * ../README.md's roadmap item 3. `task.assimilate` (../storage/database.ts/
 * db-worker.ts) has been a working, atomically-committed DB command since
 * this codebase's storage layer was built, but nothing ever called it --
 * GeneBank/PopulationRegistry/PheromoneMap stayed purely in-memory, and a
 * process restart zeroed every role's fitness/lifecycle state. This module
 * is the orchestration TaskNest (../tasks/task-nest.ts) calls, via its
 * optional `onTerminalTransition` hook, once a task actually reaches
 * completed/failed.
 *
 * Kept in its own file rather than inline in ../index.ts, mirroring
 * ../tasks/inbound-event-router.ts's and ../tools/diplomacy-persistence.ts's
 * own stated reason: no business logic belongs in the composition root.
 *
 * Deliberately narrow about what it can honestly derive from a bare
 * TaskRecord (id, roleId, status -- nothing else):
 *   - `cancelled` tasks are skipped entirely, never assimilated: a user
 *     cancellation says nothing about the assigned role's competence, so
 *     recording it as a fitness data point (success or failure) would be a
 *     fabricated signal.
 *   - `roleFitness` is exactly one `task_outcome` delta (1 success / 0
 *     failure) -- the same metric shape ../storage/database.ts's own
 *     TaskAssimilateRoleFitnessInput doc comment and existing
 *     database.test.ts fixtures already use.
 *   - `pheromone`/`memory` are always null: a real pheromone delta needs a
 *     task-feature/device/network context, and a real memory needs
 *     MemoryCurator-approved compressed content -- neither exists on a bare
 *     TaskRecord, and neither is fabricated here. A later task that threads
 *     those signals through TaskNest can extend this module without
 *     changing its public shape.
 *   - `roleName` has no source distinct from `roleId` anywhere in this
 *     codebase (neither RoleManifest nor RoleGenome declares a `name`
 *     field) -- so this module writes `roleId` itself as the `roles.name`
 *     value, rather than inventing a display name.
 *   - `roleStatus` reuses GeneBank's own already-modeled
 *     `RoleGenome.lifecycle.state` for a genome-backed (incubated) role, so
 *     a still-on-trial role is never overwritten to "resident" just because
 *     this task happened to succeed without also crossing
 *     evaluateRoleLifecycle()'s promotion threshold. A role GeneBank has
 *     never heard of (i.e. one of the seven baseline manifests, never
 *     incubated) defaults to "resident" -- baseline roles are permanent
 *     workers, never on trial.
 *
 * Persistence failures are swallowed and reported via onError (mirrors
 * ../telemetry/runtime-metrics.ts's onSample/onPersistError and
 * ../tools/diplomacy-persistence.ts's onPersistError) rather than
 * propagating back through TaskNest.transition(): the task's own state
 * transition has already durably committed by the time this hook runs, so
 * a DB hiccup here must never turn an already-successful transition() call
 * into a rejected promise.
 */

import type { RoleGenome } from "../ecology/gene-bank.js";
import { evaluateRoleLifecycle } from "../ecology/pheromone-map.js";
import type { RoleExperienceTracker } from "../ecology/role-experience.js";
import type { DbCommand, DbCommandResultMap } from "../storage/database.js";
import type { TaskRecord } from "./task-nest.js";

/** Minimal structural slice of ../storage/database.ts's DatabaseClient this module depends on -- mirrors ../tools/diplomacy-persistence.ts's DiplomacyPersistenceDb pattern. */
export interface TaskAssimilationDb {
  request<C extends DbCommand>(command: C): Promise<DbCommandResultMap[C["type"]]>;
}

/** Minimal structural slice of ../ecology/gene-bank.ts's GeneBank this module depends on. */
export interface TaskAssimilationGeneBank {
  get(roleId: string): RoleGenome | undefined;
}

export interface TaskAssimilationOptions {
  readonly db: TaskAssimilationDb;
  readonly geneBank: TaskAssimilationGeneBank;
  readonly experienceTracker: RoleExperienceTracker;
  readonly now?: () => Date;
  /** Called whenever the underlying task.assimilate write throws -- diagnostics only, never re-thrown. */
  readonly onError?: (error: unknown, taskId: string) => void;
}

const RESIDENT_ROLE_STATUS = "resident";
const DORMANT_ROLE_STATUS = "dormant";

function currentRoleStatus(roleId: string, geneBank: TaskAssimilationGeneBank): string {
  return geneBank.get(roleId)?.lifecycle.state ?? RESIDENT_ROLE_STATUS;
}

/** Builds the TaskNestOptions.onTerminalTransition hook described in the module doc comment. */
export function createTaskAssimilationHook(options: TaskAssimilationOptions): (task: TaskRecord) => Promise<void> {
  const now = options.now ?? ((): Date => new Date());
  const onError = options.onError ?? ((): void => {});

  return async (task: TaskRecord): Promise<void> => {
    if (task.roleId === null || task.status === "cancelled") {
      return;
    }
    const outcome = task.status === "completed" ? "success" : "failure";

    try {
      const nowMs = now().getTime();
      const snapshot = options.experienceTracker.recordOutcome(task.roleId, outcome, nowMs);
      const decision = evaluateRoleLifecycle(snapshot, { nowMs });

      let roleStatus = currentRoleStatus(task.roleId, options.geneBank);
      if (decision.action === "promote_resident") {
        roleStatus = RESIDENT_ROLE_STATUS;
        options.experienceTracker.resetAfterPromotion(task.roleId, nowMs);
      } else if (decision.action === "sleep" || decision.action === "release_session_keep_gene") {
        roleStatus = DORMANT_ROLE_STATUS;
      }

      await options.db.request({
        type: "task.assimilate",
        assimilation: {
          taskId: task.id,
          finalStatus: task.status,
          roleId: task.roleId,
          roleName: task.roleId,
          roleStatus,
          roleFitness: [{ metric: "task_outcome", value: outcome === "success" ? 1 : 0 }],
          pheromone: null,
          memory: null,
          updatedAt: now().toISOString(),
        },
      });
    } catch (error) {
      onError(error, task.id);
    }
  };
}
