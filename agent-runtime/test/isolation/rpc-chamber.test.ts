import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type { RoleGenome } from "../../src/ecology/gene-bank.js";
import {
  buildRestrictedEnv,
  IsolatedRoleNotFoundError,
  IsolationCapacityError,
  RpcChamber,
  RpcChamberSessionClosedError,
  RpcTimeoutError,
} from "../../src/isolation/rpc-chamber.js";
import type { RpcChildProcess, TimeoutHandle, TimeoutScheduler } from "../../src/isolation/rpc-chamber.js";

function genome(roleId: string, overrides: Partial<RoleGenome> = {}): RoleGenome {
  return {
    roleId,
    lineage: ["general"],
    capabilities: ["novel-thing"],
    tools: [],
    promptFragments: [],
    modelPolicy: { preferredClass: "fast", thinkingLevel: "low" },
    birthReason: "high_novelty: missing [novel-thing]",
    deathConditions: ["trial_ttl_expired_without_promotion"],
    lifecycle: { state: "trial", ttlTaskCycles: 1 },
    fitness: { successes: 0, failures: 0, userCorrections: 0 },
    ...overrides,
  };
}

/** Fake stdout/stderr -- just enough of a Readable's event surface for RpcChamber. */
class FakeStream extends EventEmitter {}

/** Fake child process -- records every line written to stdin and lets tests push stdout/stderr data or simulate exit, without ever spawning a real `pi` process (mirrors test/tools/mail/agently-mail.test.ts's FakeAgentlyCliTransport). */
class FakeRpcChildProcess extends EventEmitter implements RpcChildProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly writes: string[] = [];
  killed = false;

  readonly stdin = {
    write: (chunk: string): boolean => {
      this.writes.push(chunk);
      return true;
    },
    end: (): void => {},
  };

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }

  /** Test helper: simulate the child writing one JSON line to stdout. */
  emitLine(payload: Record<string, unknown>): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"));
  }

  lastWrite(): { id: string; type: string; message?: string } {
    const last = this.writes[this.writes.length - 1];
    if (!last) {
      throw new Error("FakeRpcChildProcess: no writes yet");
    }
    return JSON.parse(last) as { id: string; type: string; message?: string };
  }
}

/** Manual, synchronous timeout seam -- mirrors this codebase's injectable-time convention (see AgentlyMailClientOptions.sleep in ../../src/tools/mail/agently-mail.ts) rather than vi.useFakeTimers(), so timeout tests never depend on real wall-clock time or fake-timer/microtask ordering. */
function manualScheduler(): { scheduleTimeout: TimeoutScheduler; fire: () => void; scheduledMs: number[] } {
  let callback: (() => void) | undefined;
  const scheduledMs: number[] = [];
  const scheduleTimeout: TimeoutScheduler = (cb, ms): TimeoutHandle => {
    callback = cb;
    scheduledMs.push(ms);
    return {
      cancel: (): void => {
        callback = undefined;
      },
    };
  };
  return {
    scheduleTimeout,
    scheduledMs,
    fire: (): void => {
      callback?.();
    },
  };
}

function makeChamber(options: {
  capacity?: number;
  requestTimeoutMs?: number;
  scheduleTimeout?: TimeoutScheduler;
  processes?: FakeRpcChildProcess[];
} = {}): RpcChamber {
  const processes = options.processes ?? [];
  return new RpcChamber({
    capacity: options.capacity,
    requestTimeoutMs: options.requestTimeoutMs,
    scheduleTimeout: options.scheduleTimeout,
    spawner: (): RpcChildProcess => {
      const proc = new FakeRpcChildProcess();
      processes.push(proc);
      return proc;
    },
  });
}

describe("RpcChamber isolation capacity (Step 3 mandated test)", () => {
  it("allows only one isolated role in the first release", async () => {
    const chamber = makeChamber({ capacity: 1 });
    const first = await chamber.spawn(genome("genome-a"));

    await expect(chamber.spawn(genome("genome-b"))).rejects.toThrow(/capacity/);

    await first.close();
  });
});

describe("RpcChamber -- capacity coverage", () => {
  it("frees a capacity slot once close() runs, so a new spawn() then succeeds", async () => {
    const chamber = makeChamber({ capacity: 1 });
    const first = await chamber.spawn(genome("genome-a"));
    await first.close();

    const second = await chamber.spawn(genome("genome-b"));

    expect(chamber.activeCount).toBe(1);
    await second.close();
  });

  it("rejects with IsolationCapacityError specifically, without spawning a process", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const chamber = makeChamber({ capacity: 1, processes });
    await chamber.spawn(genome("genome-a"));

    await expect(chamber.spawn(genome("genome-b"))).rejects.toBeInstanceOf(IsolationCapacityError);
    expect(processes).toHaveLength(1);
  });

  it("supports a configured capacity greater than one", async () => {
    const chamber = makeChamber({ capacity: 2 });
    const first = await chamber.spawn(genome("genome-a"));
    const second = await chamber.spawn(genome("genome-b"));

    expect(chamber.activeCount).toBe(2);
    await expect(chamber.spawn(genome("genome-c"))).rejects.toThrow(/capacity/);

    await first.close();
    await second.close();
  });

  it("frees its capacity slot automatically if the child process exits on its own", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const chamber = makeChamber({ capacity: 1, processes });
    await chamber.spawn(genome("genome-a"));
    const proc = processes[0]!;

    proc.emit("exit", 1, null); // crashed, not via close()

    expect(chamber.activeCount).toBe(0);
    await expect(chamber.spawn(genome("genome-b"))).resolves.toBeDefined();
  });

  it("refuses to spawn an invalid genome (no birth reason/death conditions), without consuming capacity", async () => {
    const chamber = makeChamber({ capacity: 1 });

    await expect(
      chamber.spawn(genome("bad-genome", { birthReason: "", deathConditions: [] })),
    ).rejects.toThrow(/birth reason|death condition/);
    expect(chamber.activeCount).toBe(0);
  });
});

describe("RpcChamber -- prompt()/abort() round-trip through the fake child process", () => {
  it("prompt() writes a JSON request line carrying an id, and resolves once the matching response line arrives", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const chamber = makeChamber({ processes });
    const session = await chamber.spawn(genome("genome-a"));

    const pending = session.prompt("hello");
    const proc = processes[0]!;
    expect(proc.writes).toHaveLength(1);

    const sent = proc.lastWrite();
    expect(sent.type).toBe("prompt");
    expect(sent.message).toBe("hello");
    expect(typeof sent.id).toBe("string");

    proc.emitLine({ id: sent.id, type: "response", command: "prompt", success: true });

    await expect(pending).resolves.toEqual({ success: true, error: undefined });
    await session.close();
  });

  it("abort() writes an abort request and resolves on its matching response", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const chamber = makeChamber({ processes });
    const session = await chamber.spawn(genome("genome-a"));

    const pending = session.abort();
    const proc = processes[0]!;
    const sent = proc.lastWrite();
    expect(sent.type).toBe("abort");

    proc.emitLine({ id: sent.id, type: "response", command: "abort", success: true });

    await expect(pending).resolves.toEqual({ success: true, error: undefined });
    await session.close();
  });

  it("surfaces a failure response's error message", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const chamber = makeChamber({ processes });
    const session = await chamber.spawn(genome("genome-a"));

    const pending = session.prompt("hello");
    const proc = processes[0]!;
    const sent = proc.lastWrite();
    proc.emitLine({ id: sent.id, type: "response", command: "prompt", success: false, error: "model not found" });

    await expect(pending).resolves.toEqual({ success: false, error: "model not found" });
    await session.close();
  });

  it("ignores real event-stream lines (message_update, tool_execution_*, ...) without throwing", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const chamber = makeChamber({ processes });
    const session = await chamber.spawn(genome("genome-a"));
    const proc = processes[0]!;

    expect(() => proc.emitLine({ type: "message_update", message: {} })).not.toThrow();
    expect(() => proc.emitLine({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash" })).not.toThrow();

    await session.close();
  });

  it("ignores a response line whose id does not match any pending request", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const chamber = makeChamber({ processes });
    const session = await chamber.spawn(genome("genome-a"));
    const proc = processes[0]!;

    expect(() => proc.emitLine({ id: "unknown-id", type: "response", command: "prompt", success: true })).not.toThrow();

    await session.close();
  });
});

describe("RpcChamber -- timeout handling", () => {
  it("a timed-out request sends an abort message for that id, then terminates the process", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const scheduler = manualScheduler();
    const chamber = makeChamber({ processes, scheduleTimeout: scheduler.scheduleTimeout, requestTimeoutMs: 50 });
    const session = await chamber.spawn(genome("genome-a"));
    const proc = processes[0]!;

    const pending = session.prompt("hello");
    const promptId = proc.lastWrite().id;
    expect(scheduler.scheduledMs).toEqual([50]);

    scheduler.fire();

    await expect(pending).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(proc.writes).toHaveLength(2);
    const abortSent = proc.lastWrite();
    expect(abortSent.type).toBe("abort");
    expect(abortSent.id).toBe(promptId);
    expect(proc.killed).toBe(true);
  });

  it("frees the chamber's capacity slot once a timeout kills the process", async () => {
    const scheduler = manualScheduler();
    const chamber = makeChamber({ capacity: 1, scheduleTimeout: scheduler.scheduleTimeout, requestTimeoutMs: 10 });
    const session = await chamber.spawn(genome("genome-a"));

    const pending = session.prompt("hello");
    scheduler.fire();
    await pending.catch(() => undefined);

    expect(chamber.activeCount).toBe(0);
    await expect(chamber.spawn(genome("genome-b"))).resolves.toBeDefined();
  });

  it("a response that arrives after the response for an earlier timed-out request is simply ignored", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const scheduler = manualScheduler();
    const chamber = makeChamber({ processes, scheduleTimeout: scheduler.scheduleTimeout, requestTimeoutMs: 10 });
    const session = await chamber.spawn(genome("genome-a"));
    const proc = processes[0]!;

    const pending = session.prompt("hello");
    const promptId = proc.lastWrite().id;
    scheduler.fire();
    await pending.catch(() => undefined);

    // A stray late response for the already-timed-out id must not throw,
    // even though the process (and session) is already closed.
    expect(() => proc.emitLine({ id: promptId, type: "response", command: "prompt", success: true })).not.toThrow();
  });
});

describe("RpcChamber -- stderr ring buffer", () => {
  it("caps stderr at 1MiB rather than growing without bound, keeping the most recent bytes", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const chamber = makeChamber({ processes });
    const session = await chamber.spawn(genome("genome-a"));
    const proc = processes[0]!;

    const chunkA = Buffer.alloc(600 * 1024, "a");
    const chunkB = Buffer.alloc(600 * 1024, "b");
    proc.stderr.emit("data", chunkA);
    proc.stderr.emit("data", chunkB); // 1.2MiB total pushed, cap is 1MiB

    expect(session.stderrTail.length).toBeLessThanOrEqual(1024 * 1024);
    // The ring buffer keeps the tail (most recent bytes) -- chunkB (the
    // more recent push) must still be present; chunkA must have been
    // partially evicted.
    expect(session.stderrTail.endsWith("b".repeat(100))).toBe(true);

    await session.close();
  });
});

describe("RpcChamber -- close() semantics", () => {
  it("close() is idempotent and rejects any still-pending request", async () => {
    const chamber = makeChamber();
    const session = await chamber.spawn(genome("genome-a"));

    const pending = session.prompt("hello");
    await session.close();
    await session.close(); // idempotent, no throw

    await expect(pending).rejects.toThrow();
  });

  it("prompt()/abort() reject once the session is closed", async () => {
    const chamber = makeChamber();
    const session = await chamber.spawn(genome("genome-a"));
    await session.close();

    await expect(session.prompt("hello")).rejects.toBeInstanceOf(RpcChamberSessionClosedError);
    await expect(session.abort()).rejects.toBeInstanceOf(RpcChamberSessionClosedError);
  });

  it("chamber.close() closes every currently-running isolated session", async () => {
    const chamber = makeChamber({ capacity: 2 });
    await chamber.spawn(genome("genome-a"));
    await chamber.spawn(genome("genome-b"));
    expect(chamber.activeCount).toBe(2);

    await chamber.close();

    expect(chamber.activeCount).toBe(0);
  });
});

describe("RpcChamber roleId-keyed convenience methods", () => {
  it("prompt(roleId)/abort(roleId) delegate to the active session for that role", async () => {
    const processes: FakeRpcChildProcess[] = [];
    const chamber = makeChamber({ processes });
    await chamber.spawn(genome("mail-worker-trial"));
    const proc = processes[0]!;

    const pending = chamber.prompt("mail-worker-trial", "hi");
    const sent = proc.lastWrite();
    proc.emitLine({ id: sent.id, type: "response", command: "prompt", success: true });

    await expect(pending).resolves.toEqual({ success: true, error: undefined });
    await chamber.close();
  });

  it("throws IsolatedRoleNotFoundError for a roleId with no active session", async () => {
    const chamber = makeChamber();
    await expect(chamber.prompt("ghost", "hi")).rejects.toBeInstanceOf(IsolatedRoleNotFoundError);
    await expect(chamber.abort("ghost")).rejects.toBeInstanceOf(IsolatedRoleNotFoundError);
  });
});

describe("buildRestrictedEnv", () => {
  it("only passes through an explicit allowlist, never the full parent environment", () => {
    const restricted = buildRestrictedEnv(
      { PATH: "/usr/bin", HOME: "/home/x", SECRET_TOKEN: "leak-me", ANTHROPIC_API_KEY: "sk-123" },
      ["ANTHROPIC_API_KEY"],
    );

    expect(restricted).toEqual({ PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-123" });
    expect(restricted["SECRET_TOKEN"]).toBeUndefined();
  });

  it("omits an allowlisted variable that is simply absent from the base environment", () => {
    const restricted = buildRestrictedEnv({ PATH: "/usr/bin" }, ["ANTHROPIC_API_KEY"]);
    expect(restricted).toEqual({ PATH: "/usr/bin" });
  });
});
