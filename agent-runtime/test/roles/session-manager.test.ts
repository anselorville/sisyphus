import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { RoleManifestRegistry } from "../../src/roles/registry.js";
import {
  PiRoleSessionManager,
  RoleSessionDisposedError,
  RoleSessionNotFoundError,
} from "../../src/roles/session-manager.js";
import type { PiSession, PiSessionProvider, RoleManifest, RoleSessionUpdate } from "../../src/roles/types.js";

function manifest(overrides: Partial<RoleManifest> & Pick<RoleManifest, "id">): RoleManifest {
  return {
    capabilities: [],
    tools: ["read"],
    promptPath: `resources/roles/${overrides.id}.md`, // the fake provider below never reads this file
    modelClass: "balanced",
    thinkingLevel: "medium",
    lifecycle: "resident",
    ...overrides,
  };
}

const codeManifest = manifest({ id: "code", capabilities: ["code"], tools: ["read", "bash", "edit"] });
const mailManifest = manifest({ id: "mail", capabilities: ["mail"], tools: ["read"] });

function textDeltaEvent(delta: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: { role: "assistant", content: [] } },
  } as unknown as AgentSessionEvent;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fake PiSession, scoped to this test file. Matches src/roles/types.ts's
 * `PiSession` -- the minimal structural slice of the real
 * `@earendil-works/pi-coding-agent` AgentSession this codebase depends on
 * (verified against node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts).
 * Never touches a real Pi backend.
 */
class FakePiSession implements PiSession {
  readonly promptedTexts: string[] = [];
  disposed = false;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.promptedTexts.push(text);
  }

  async steer(text: string): Promise<void> {
    this.promptedTexts.push(`steer:${text}`);
  }

  async followUp(text: string): Promise<void> {
    this.promptedTexts.push(`followUp:${text}`);
  }

  async abort(): Promise<void> {
    this.promptedTexts.push("abort");
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  get messages(): readonly unknown[] {
    return this.promptedTexts;
  }

  /** Test-only: simulates the underlying Pi Session emitting a real SDK event. */
  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

interface FakePiWorld {
  readonly provider: PiSessionProvider;
  readonly sessions: Map<string, FakePiSession>;
  readonly constructions: Array<{ roleId: string; session: FakePiSession }>;
}

function makeFakePiWorld(): FakePiWorld {
  const sessions = new Map<string, FakePiSession>();
  const constructions: Array<{ roleId: string; session: FakePiSession }> = [];
  const provider: PiSessionProvider = async (roleManifest) => {
    const session = new FakePiSession();
    sessions.set(roleManifest.id, session);
    constructions.push({ roleId: roleManifest.id, session });
    return session;
  };
  return { provider, sessions, constructions };
}

const managers: PiRoleSessionManager[] = [];

/** Registers "code" and "mail" manifests up front so prompt()/steer()/etc. can resolve them by bare roleId, matching how a real registry would be pre-populated at startup. */
function makeManagerWithFakePiWorld(flushIntervalMs = 20): FakePiWorld & { manager: PiRoleSessionManager } {
  const registry = new RoleManifestRegistry();
  registry.register(codeManifest);
  registry.register(mailManifest);
  const world = makeFakePiWorld();
  const manager = new PiRoleSessionManager({ registry, provider: world.provider, flushIntervalMs });
  managers.push(manager);
  return { manager, ...world };
}

function makeManagerWithFakePi(): PiRoleSessionManager {
  return makeManagerWithFakePiWorld().manager;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

describe("role isolation", () => {
  it("keeps message history isolated by role", async () => {
    const manager = makeManagerWithFakePi();
    await manager.prompt("code", "t1", "run tests");
    await manager.prompt("mail", "t2", "read inbox");
    expect(manager.debugMessages("code")).not.toEqual(manager.debugMessages("mail"));
  });

  it("gives each role its own independent Pi Session", async () => {
    const { manager, sessions } = makeManagerWithFakePiWorld();
    const codeSession = await manager.ensure(codeManifest);
    const mailSession = await manager.ensure(mailManifest);

    expect(codeSession).not.toBe(mailSession);
    expect(sessions.get("code")).not.toBe(sessions.get("mail"));
  });

  it("reuses the same ManagedRoleSession on repeated ensure() calls for the same role", async () => {
    const manager = makeManagerWithFakePi();
    const first = await manager.ensure(codeManifest);
    const second = await manager.ensure(codeManifest);
    expect(first).toBe(second);
  });

  it("dedupes concurrent ensure() calls for a brand-new role into a single Pi Session", async () => {
    const { manager, constructions } = makeManagerWithFakePiWorld();
    const [a, b] = await Promise.all([manager.ensure(codeManifest), manager.ensure(codeManifest)]);

    expect(a).toBe(b);
    expect(constructions.filter((c) => c.roleId === "code")).toHaveLength(1);
  });

  it("prompt() auto-provisions a session from the registry without a prior ensure() call", async () => {
    const manager = makeManagerWithFakePi();
    expect(manager.debugActiveSubscriptions("code")).toBe(0);

    await manager.prompt("code", "t1", "run tests");

    expect(manager.debugActiveSubscriptions("code")).toBeGreaterThan(0);
  });
});

describe("sleep releases resources", () => {
  it("unsubscribes and disposes when a role sleeps", async () => {
    const manager = makeManagerWithFakePi();
    await manager.ensure(codeManifest);
    await manager.sleep("code");
    expect(manager.debugActiveSubscriptions("code")).toBe(0);
  });

  it("disposes and unsubscribes the underlying Pi Session itself, not just this layer's bookkeeping", async () => {
    const { manager, sessions } = makeManagerWithFakePiWorld();
    await manager.ensure(codeManifest);
    const fakeSession = sessions.get("code")!;
    expect(fakeSession.listenerCount).toBeGreaterThan(0);

    await manager.sleep("code");

    expect(fakeSession.disposed).toBe(true);
    expect(fakeSession.listenerCount).toBe(0);
  });

  it("sleep() on a role that was never started is a harmless no-op", async () => {
    const manager = makeManagerWithFakePi();
    await expect(manager.sleep("code")).resolves.toBeUndefined();
    expect(manager.debugActiveSubscriptions("code")).toBe(0);
  });

  it("provisions a brand new Pi Session the next time a slept role is used", async () => {
    const { manager, constructions } = makeManagerWithFakePiWorld();
    await manager.prompt("code", "t1", "first");
    await manager.sleep("code");
    await manager.prompt("code", "t2", "second");

    const codeConstructions = constructions.filter((c) => c.roleId === "code");
    expect(codeConstructions).toHaveLength(2);
    expect(codeConstructions[0]!.session).not.toBe(codeConstructions[1]!.session);
  });

  it("rejects further use of a ManagedRoleSession reference held from before sleep()", async () => {
    const manager = makeManagerWithFakePi();
    const session = await manager.ensure(codeManifest);
    await manager.sleep("code");

    await expect(session.prompt("t1", "too late")).rejects.toThrow(RoleSessionDisposedError);
  });

  it("close() disposes every currently-active role session", async () => {
    const { manager, sessions } = makeManagerWithFakePiWorld();
    await manager.ensure(codeManifest);
    await manager.ensure(mailManifest);

    await manager.close();

    expect(sessions.get("code")!.disposed).toBe(true);
    expect(sessions.get("mail")!.disposed).toBe(true);
    expect(manager.debugActiveSubscriptions("code")).toBe(0);
    expect(manager.debugActiveSubscriptions("mail")).toBe(0);
  });
});

describe("prompt/steer/followUp/abort delegation", () => {
  it("steer()/followUp() delegate to the underlying Pi Session and track currentTaskId", async () => {
    const { manager, sessions } = makeManagerWithFakePiWorld();
    const session = await manager.ensure(codeManifest);
    await manager.prompt("code", "t1", "start");
    await manager.steer("code", "t1", "actually wait");
    await manager.followUp("code", "t1", "then continue");

    expect(sessions.get("code")!.promptedTexts).toEqual(["start", "steer:actually wait", "followUp:then continue"]);
    expect(session.currentTaskId).toBe("t1");
  });

  it("abort() delegates to the underlying Pi Session", async () => {
    const { manager, sessions } = makeManagerWithFakePiWorld();
    await manager.prompt("code", "t1", "start");
    await manager.abort("code", "t1");

    expect(sessions.get("code")!.promptedTexts).toContain("abort");
  });

  it("prompt() throws for a completely unknown role", async () => {
    const manager = makeManagerWithFakePi();
    await expect(manager.prompt("ghost", "t1", "hi")).rejects.toThrow(RoleSessionNotFoundError);
  });

  it("steer()/followUp()/abort() throw if the role was never started", async () => {
    const manager = makeManagerWithFakePi();
    await expect(manager.steer("code", "t1", "wait")).rejects.toThrow(RoleSessionNotFoundError);
    await expect(manager.followUp("code", "t1", "go on")).rejects.toThrow(RoleSessionNotFoundError);
    await expect(manager.abort("code", "t1")).rejects.toThrow(RoleSessionNotFoundError);
  });
});

describe("aggregated update broadcasting", () => {
  it("delivers discrete events (agent_start) immediately, without waiting for the flush timer", async () => {
    const { manager, sessions } = makeManagerWithFakePiWorld(10_000);
    const session = await manager.ensure(codeManifest);
    const updates: RoleSessionUpdate[] = [];
    session.subscribe((update) => updates.push(update));

    sessions.get("code")!.emit({ type: "agent_start" } as unknown as AgentSessionEvent);

    expect(updates).toEqual([{ type: "task.assigned", payload: {}, roleId: "code", taskId: undefined }]);
  });

  it("delivers aggregated message_update text via the flush timer, tagged with role and task", async () => {
    const { manager, sessions } = makeManagerWithFakePiWorld(10);
    const session = await manager.ensure(codeManifest);
    await manager.prompt("code", "t1", "go");

    const updates: RoleSessionUpdate[] = [];
    const unsubscribe = session.subscribe((update) => updates.push(update));

    sessions.get("code")!.emit(textDeltaEvent("hi"));
    sessions.get("code")!.emit(textDeltaEvent(" there"));

    await delay(60); // well past the 10ms flush interval
    unsubscribe();

    const progress = updates.find(
      (update) => update.type === "task.progress" && typeof update.payload.text === "string",
    );
    expect(progress).toMatchObject({
      type: "task.progress",
      payload: { text: "hi there" },
      roleId: "code",
      taskId: "t1",
    });
  });

  it("subscribe() returning its unsubscribe function stops further delivery and releases the slot", async () => {
    const { manager, sessions } = makeManagerWithFakePiWorld();
    const session = await manager.ensure(codeManifest);
    const before = session.activeSubscriptionCount;

    const updates: RoleSessionUpdate[] = [];
    const unsubscribe = session.subscribe((update) => updates.push(update));
    expect(session.activeSubscriptionCount).toBe(before + 1);

    unsubscribe();
    expect(session.activeSubscriptionCount).toBe(before);

    sessions.get("code")!.emit({ type: "agent_start" } as unknown as AgentSessionEvent);
    expect(updates).toEqual([]);
  });
});
