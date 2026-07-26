import { describe, expect, it } from "vitest";

import type { RoleGenome } from "../../src/ecology/gene-bank.js";
import { RoleExperienceTracker } from "../../src/ecology/role-experience.js";
import type { DbCommand } from "../../src/storage/database.js";
import type { TaskAssimilationDb, TaskAssimilationGeneBank } from "../../src/tasks/task-assimilation.js";
import { createTaskAssimilationHook } from "../../src/tasks/task-assimilation.js";
import type { TaskRecord } from "../../src/tasks/task-nest.js";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    goal: "send a report",
    interactionId: "interaction-1",
    status: "completed",
    roleId: "mail",
    parentTaskId: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function genome(overrides: Partial<RoleGenome> = {}): RoleGenome {
  return {
    roleId: "mail-trial",
    lineage: ["general"],
    capabilities: ["mail"],
    tools: [],
    promptFragments: [],
    modelPolicy: { preferredClass: "fast", thinkingLevel: "low" },
    birthReason: "high_novelty",
    deathConditions: ["trial_ttl_expired_without_promotion"],
    lifecycle: { state: "trial", ttlTaskCycles: 1 },
    fitness: { successes: 0, failures: 0, userCorrections: 0 },
    ...overrides,
  };
}

class FakeGeneBank implements TaskAssimilationGeneBank {
  private readonly genomes = new Map<string, RoleGenome>();

  set(g: RoleGenome): void {
    this.genomes.set(g.roleId, g);
  }

  get(roleId: string): RoleGenome | undefined {
    return this.genomes.get(roleId);
  }
}

class FakeDb implements TaskAssimilationDb {
  readonly calls: DbCommand[] = [];
  private readonly shouldThrow: boolean;

  constructor(shouldThrow = false) {
    this.shouldThrow = shouldThrow;
  }

  async request(command: DbCommand): Promise<never> {
    this.calls.push(command);
    if (this.shouldThrow) {
      throw new Error("simulated db failure");
    }
    return { recorded: true } as never;
  }
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

describe("createTaskAssimilationHook (Roadmap #3: task ends -> assimilate)", () => {
  it("no-ops for a task with no assigned role -- nothing to assimilate", async () => {
    const db = new FakeDb();
    const hook = createTaskAssimilationHook({ db, geneBank: new FakeGeneBank(), experienceTracker: new RoleExperienceTracker() });

    await hook(task({ roleId: null }));

    expect(db.calls).toEqual([]);
  });

  it("skips a cancelled task entirely -- a user cancellation is never a fitness signal", async () => {
    const db = new FakeDb();
    const hook = createTaskAssimilationHook({ db, geneBank: new FakeGeneBank(), experienceTracker: new RoleExperienceTracker() });

    await hook(task({ status: "cancelled" }));

    expect(db.calls).toEqual([]);
  });

  it("assimilates a completed task with a task_outcome=1 fitness delta, defaulting roleStatus to resident for a role GeneBank has never heard of", async () => {
    const db = new FakeDb();
    const hook = createTaskAssimilationHook({
      db,
      geneBank: new FakeGeneBank(),
      experienceTracker: new RoleExperienceTracker(),
      now: fixedNow("2026-01-01T00:10:00.000Z"),
    });

    await hook(task({ status: "completed", roleId: "mail" }));

    expect(db.calls).toEqual([
      {
        type: "task.assimilate",
        assimilation: {
          taskId: "task-1",
          finalStatus: "completed",
          roleId: "mail",
          roleName: "mail",
          roleStatus: "resident",
          roleFitness: [{ metric: "task_outcome", value: 1 }],
          pheromone: null,
          memory: null,
          updatedAt: "2026-01-01T00:10:00.000Z",
        },
      },
    ]);
  });

  it("assimilates a failed task with a task_outcome=0 fitness delta", async () => {
    const db = new FakeDb();
    const hook = createTaskAssimilationHook({ db, geneBank: new FakeGeneBank(), experienceTracker: new RoleExperienceTracker() });

    await hook(task({ status: "failed", roleId: "mail" }));

    expect(db.calls[0]).toMatchObject({ assimilation: { finalStatus: "failed", roleFitness: [{ metric: "task_outcome", value: 0 }] } });
  });

  it("preserves a genome-backed role's current lifecycle.state (e.g. still 'trial') instead of overwriting it to resident on an ordinary success", async () => {
    const db = new FakeDb();
    const geneBank = new FakeGeneBank();
    geneBank.set(genome({ roleId: "mail-trial", lifecycle: { state: "trial", ttlTaskCycles: 1 } }));
    const hook = createTaskAssimilationHook({ db, geneBank, experienceTracker: new RoleExperienceTracker() });

    await hook(task({ status: "completed", roleId: "mail-trial" }));

    expect(db.calls[0]).toMatchObject({ assimilation: { roleStatus: "trial" } });
  });

  it("promotes to resident once the role crosses the cross-task-success threshold, and resets the tracker's success count", async () => {
    const db = new FakeDb();
    const geneBank = new FakeGeneBank();
    geneBank.set(genome({ roleId: "mail-trial", lifecycle: { state: "trial", ttlTaskCycles: 1 } }));
    const experienceTracker = new RoleExperienceTracker();
    const hook = createTaskAssimilationHook({ db, geneBank, experienceTracker, now: fixedNow("2026-01-01T00:00:00.000Z") });

    await hook(task({ id: "t1", status: "completed", roleId: "mail-trial" }));
    await hook(task({ id: "t2", status: "completed", roleId: "mail-trial" }));
    await hook(task({ id: "t3", status: "completed", roleId: "mail-trial" }));

    expect(db.calls[2]).toMatchObject({ assimilation: { roleStatus: "resident" } });
    expect(experienceTracker.get("mail-trial").crossTaskSuccessCount).toBe(0);
  });

  it("marks a role dormant once it hits the consecutive-failure sleep threshold", async () => {
    const db = new FakeDb();
    const geneBank = new FakeGeneBank();
    geneBank.set(genome({ roleId: "mail-trial" }));
    const hook = createTaskAssimilationHook({ db, geneBank, experienceTracker: new RoleExperienceTracker() });

    await hook(task({ id: "t1", status: "failed", roleId: "mail-trial" }));
    await hook(task({ id: "t2", status: "failed", roleId: "mail-trial" }));

    expect(db.calls[1]).toMatchObject({ assimilation: { roleStatus: "dormant" } });
  });

  it("swallows a persistence failure and reports it via onError instead of throwing", async () => {
    const db = new FakeDb(true);
    const errors: Array<{ error: unknown; taskId: string }> = [];
    const hook = createTaskAssimilationHook({
      db,
      geneBank: new FakeGeneBank(),
      experienceTracker: new RoleExperienceTracker(),
      onError: (error, taskId) => errors.push({ error, taskId }),
    });

    await expect(hook(task())).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.taskId).toBe("task-1");
  });
});
