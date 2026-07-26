import { describe, expect, it } from "vitest";

import type { DbCommand } from "../../src/storage/database.js";
import type { DiplomacyLogEntry, ElevationApprovalRecord, PendingElevationRequest } from "../../src/tools/capability-gateway.js";
import type { DiplomacyPersistenceDb } from "../../src/tools/diplomacy-persistence.js";
import { createDiplomacyPersistenceHooks } from "../../src/tools/diplomacy-persistence.js";
import type { RealtimeEvent } from "../../src/protocol/events.js";
import type { ActionEnvelope } from "../../src/tools/diplomacy-officer.js";

function envelope(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    taskId: "task-1",
    roleId: "device",
    toolName: "device-tools.shutdown",
    targetSummary: "shutdown printer-01",
    reversible: false,
    affectedObjects: 1,
    externalAudience: 0,
    sensitiveData: false,
    threatensAvailability: true,
    operation: "shutdown",
    ...overrides,
  };
}

function pendingRequest(overrides: Partial<PendingElevationRequest> = {}): PendingElevationRequest {
  return {
    requestId: "req-1",
    target: "shutdown printer-01",
    envelope: envelope(),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides: Partial<ElevationApprovalRecord> = {}): ElevationApprovalRecord {
  return {
    requestId: "req-1",
    target: "shutdown printer-01",
    approvedAt: "2026-01-01T00:05:00.000Z",
    expiresAt: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

/** Fake DatabaseClient -- records every command, optionally rejects the configured types. Mirrors test/tools/capability-gateway.test.ts's FakeDiplomacyOfficer pattern. */
class FakeDb implements DiplomacyPersistenceDb {
  readonly calls: DbCommand[] = [];
  private readonly failing: ReadonlySet<DbCommand["type"]>;

  constructor(failing: readonly DbCommand["type"][] = []) {
    this.failing = new Set(failing);
  }

  async request(command: DbCommand): Promise<never> {
    this.calls.push(command);
    if (this.failing.has(command.type)) {
      throw new Error(`simulated failure for ${command.type}`);
    }
    return { recorded: true } as never;
  }
}

function makeHooks(overrides: Partial<Parameters<typeof createDiplomacyPersistenceHooks>[0]> = {}): {
  hooks: ReturnType<typeof createDiplomacyPersistenceHooks>;
  db: FakeDb;
  broadcasts: RealtimeEvent[];
  persistErrors: Array<{ error: unknown; context: string }>;
} {
  const db = overrides.db instanceof FakeDb ? overrides.db : new FakeDb();
  const broadcasts: RealtimeEvent[] = [];
  const persistErrors: Array<{ error: unknown; context: string }> = [];
  let sequence = 0;

  const hooks = createDiplomacyPersistenceHooks({
    db,
    broadcast: (event) => broadcasts.push(event),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    nextEventId: (() => {
      let id = 0;
      return () => `event-${++id}`;
    })(),
    nextSequence: () => ++sequence,
    onPersistError: (error, context) => persistErrors.push({ error, context }),
    ...overrides,
  });

  return { hooks, db, broadcasts, persistErrors };
}

describe("createDiplomacyPersistenceHooks -- onLog (Roadmap #2)", () => {
  it("persists a diplomacy_log entry via db.request, but never broadcasts (DiplomacyLogEntry has no RealtimeEventType)", async () => {
    const { hooks, db, broadcasts } = makeHooks();
    const entry: DiplomacyLogEntry = {
      taskId: "task-1",
      roleId: "mail",
      toolName: "agently-mail.send",
      target: "email to a@example.com",
      operation: "send",
      decision: "ALLOW_LOGGED",
      impact: "send on \"email to a@example.com\"",
      recoveryNote: undefined,
      recordedAt: "2026-01-01T00:00:00.000Z",
    };

    await hooks.onLog(entry);

    expect(db.calls).toEqual([
      {
        type: "diplomacy.log",
        entry: {
          taskId: "task-1",
          roleId: "mail",
          toolName: "agently-mail.send",
          target: "email to a@example.com",
          operation: "send",
          decision: "ALLOW_LOGGED",
          impact: "send on \"email to a@example.com\"",
          recoveryNote: null,
          recordedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    expect(broadcasts).toEqual([]);
  });

  it("swallows a persistence failure and reports it via onPersistError instead of throwing", async () => {
    const { hooks, persistErrors } = makeHooks({ db: new FakeDb(["diplomacy.log"]) });

    await expect(
      hooks.onLog({
        taskId: "task-1",
        roleId: "mail",
        toolName: "agently-mail.send",
        target: "x",
        operation: "send",
        decision: "ALLOW_LOGGED",
        impact: "x",
        recoveryNote: undefined,
        recordedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();

    expect(persistErrors).toHaveLength(1);
    expect(persistErrors[0]?.context).toBe("onLog");
  });
});

describe("createDiplomacyPersistenceHooks -- onElevationRequested (Roadmap #2)", () => {
  it("persists the pending elevation AND broadcasts diplomacy.elevation.requested", async () => {
    const { hooks, db, broadcasts } = makeHooks();

    await hooks.onElevationRequested(pendingRequest());

    expect(db.calls).toEqual([
      {
        type: "diplomacy.elevation-requested",
        request: {
          requestId: "req-1",
          taskId: "task-1",
          roleId: "device",
          toolName: "device-tools.shutdown",
          target: "shutdown printer-01",
          operation: "shutdown",
          envelope: envelope(),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toEqual({
      event_id: "event-1",
      sequence: 1,
      source: "swarm",
      type: "diplomacy.elevation.requested",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {
        request_id: "req-1",
        task_id: "task-1",
        role_id: "device",
        tool_name: "device-tools.shutdown",
        target: "shutdown printer-01",
        operation: "shutdown",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  it("swallows a persistence failure and never broadcasts a stale/unpersisted event", async () => {
    const { hooks, broadcasts, persistErrors } = makeHooks({ db: new FakeDb(["diplomacy.elevation-requested"]) });

    await hooks.onElevationRequested(pendingRequest());

    expect(broadcasts).toEqual([]);
    expect(persistErrors).toHaveLength(1);
    expect(persistErrors[0]?.context).toBe("onElevationRequested");
  });

  it("assigns a strictly increasing sequence across multiple requests", async () => {
    const { hooks, broadcasts } = makeHooks();

    await hooks.onElevationRequested(pendingRequest({ requestId: "req-a" }));
    await hooks.onElevationRequested(pendingRequest({ requestId: "req-b" }));

    expect(broadcasts.map((event) => event.sequence)).toEqual([1, 2]);
  });
});

describe("createDiplomacyPersistenceHooks -- onElevationResolved (Roadmap #2)", () => {
  it("persists the approval AND broadcasts diplomacy.elevation.resolved", async () => {
    const { hooks, db, broadcasts } = makeHooks();

    await hooks.onElevationResolved(approval());

    expect(db.calls).toEqual([
      {
        type: "diplomacy.elevation-resolved",
        approval: {
          requestId: "req-1",
          target: "shutdown printer-01",
          approvedAt: "2026-01-01T00:05:00.000Z",
          expiresAt: "2026-01-01T00:10:00.000Z",
        },
      },
    ]);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: "diplomacy.elevation.resolved",
      payload: {
        request_id: "req-1",
        target: "shutdown printer-01",
        approved_at: "2026-01-01T00:05:00.000Z",
        expires_at: "2026-01-01T00:10:00.000Z",
      },
    });
  });

  it("persists a null expiresAt as null, not undefined (elevationTtlMs: 0 disables expiry)", async () => {
    const { hooks, db, broadcasts } = makeHooks();

    await hooks.onElevationResolved(approval({ expiresAt: undefined }));

    expect(db.calls[0]).toMatchObject({ approval: { expiresAt: null } });
    expect(broadcasts[0]?.payload).toMatchObject({ expires_at: null });
  });

  it("swallows a broadcast failure without throwing back into CapabilityGateway.approve()", async () => {
    const { hooks, persistErrors } = makeHooks({
      broadcast: (): void => {
        throw new Error("socket gone");
      },
    });

    await expect(hooks.onElevationResolved(approval())).resolves.toBeUndefined();
    expect(persistErrors).toHaveLength(1);
    expect(persistErrors[0]?.context).toBe("onElevationResolved");
  });
});
