/**
 * Task 19: four resident Pi role sessions, 1,000 short turns, checking that
 * RSS growth stabilizes and every session's subscription bookkeeping stays
 * bounded -- section 15.5's "four active resident sessions" RSS budget and
 * section 15.4's "every Map/cache/Session/subscription must have a release
 * path and a cap" constraint.
 *
 * Level chosen: `PiRoleSessionManager` directly, not
 * `createAgentRuntime()`. `PiRoleSessionManager` (src/roles/session-manager.ts)
 * is the exact object that owns the four resident sessions' in-memory
 * footprint across many turns -- its `PiManagedRoleSession` holds the Pi
 * event subscription, the flush timer, and every external subscribe()
 * listener this test is checking for leaks. Going through the full
 * composition root would additionally construct a DB Worker thread and a
 * WebSocket server, neither of which this test exercises or whose memory
 * behavior is relevant here -- that would only add unrelated allocations to
 * the RSS signal this test is trying to isolate. (event-loop.test.ts and
 * database-contention.test.ts are where the DB/WebSocket layer's own
 * behavior under load is actually under test.)
 *
 * GC-forcing mechanism: Node's `--expose-gc`, wired via
 * agent-runtime/vitest.config.ts's `execArgv: ["--expose-gc"]` (applies to
 * every test file's worker/fork process; harmless for the rest of the
 * suite, which never calls `global.gc()`). This test fails loudly with an
 * actionable message if `global.gc` isn't present, rather than silently
 * skipping the measurement.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { RoleManifestRegistry } from "../../src/roles/registry.js";
import { CODE_ROLE_MANIFEST, DEVICE_ROLE_MANIFEST, GENERAL_ROLE_MANIFEST, WEB_ROLE_MANIFEST } from "../../src/roles/manifests.js";
import { PiRoleSessionManager } from "../../src/roles/session-manager.js";
import type { ManagedRoleSession, PiSession, PiSessionProvider, RoleManifest } from "../../src/roles/types.js";

const ROLE_MANIFESTS: readonly RoleManifest[] = [
  GENERAL_ROLE_MANIFEST,
  CODE_ROLE_MANIFEST,
  WEB_ROLE_MANIFEST,
  DEVICE_ROLE_MANIFEST,
];

const TOTAL_TURNS = 1_000;
const ROUNDS = 4;
const TURNS_PER_ROUND = TOTAL_TURNS / ROUNDS;
const UPDATES_EXPECTED_PER_TURN = 4; // agent_start, tool_execution_start, tool_execution_end, agent_end -- all discrete, no flush-timer dependency

// Generous but finite: a real per-turn leak (an un-released subscription,
// timer, or Map entry) across 750 further turns (rounds 2-4, past warmup)
// would clearly blow past this. Not a "print a warning" check -- this is a
// real, failing `expect()`.
const MAX_RSS_GROWTH_AFTER_WARMUP_BYTES = 30 * 1024 * 1024;

/**
 * Never touches a real Pi backend. Deliberately keeps its own state O(1)
 * per turn (no growing arrays) so this test's own scaffolding contributes
 * ~zero heap growth of its own -- any RSS growth observed must come from
 * the runtime under test, not from this fake.
 */
class FakePiSession implements PiSession {
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  promptCount = 0;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(_text: string): Promise<void> {
    this.promptCount += 1;
  }

  async steer(_text: string): Promise<void> {}
  async followUp(_text: string): Promise<void> {}
  async abort(): Promise<void> {}

  dispose(): void {
    this.listeners.clear();
  }

  get messages(): readonly unknown[] {
    return [];
  }

  /** Test-only: simulates one turn's worth of real Pi SDK events. All four kinds map to a discrete, immediately-broadcast update (see ../../src/roles/pi-event-adapter.ts) -- no flush timer involved, so this test never needs to race it. */
  emitTurnEvents(): void {
    const events: AgentSessionEvent[] = [
      { type: "agent_start" } as unknown as AgentSessionEvent,
      { type: "tool_execution_start", toolCallId: "t1", toolName: "noop", args: {} } as unknown as AgentSessionEvent,
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "noop",
        result: "ok",
        isError: false,
      } as unknown as AgentSessionEvent,
      { type: "agent_end", willRetry: false } as unknown as AgentSessionEvent,
    ];
    for (const event of events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }
}

function forceGcAndMeasureRssBytes(): number {
  if (typeof global.gc !== "function") {
    throw new Error(
      "session-memory test requires Node's global.gc() -- run with --expose-gc " +
        "(agent-runtime/vitest.config.ts already sets execArgv: [\"--expose-gc\"]; " +
        "if this still fails, the test runner isn't picking that config up)",
    );
  }
  global.gc();
  global.gc(); // a second pass lets finalizers from the first settle before the measurement
  return process.memoryUsage().rss;
}

const managers: PiRoleSessionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

describe("resident session memory over many turns", () => {
  it(
    "stabilizes RSS growth and keeps every session's subscription count at a fixed baseline across 1,000 turns",
    async () => {
      const registry = new RoleManifestRegistry();
      const fakeSessions = new Map<string, FakePiSession>();
      const provider: PiSessionProvider = async (manifest) => {
        const session = new FakePiSession();
        fakeSessions.set(manifest.id, session);
        return session;
      };
      const manager = new PiRoleSessionManager({ registry, provider, flushIntervalMs: 10 });
      managers.push(manager);

      const managedSessions: ManagedRoleSession[] = await Promise.all(
        ROLE_MANIFESTS.map((manifest) => manager.ensure(manifest)),
      );

      const baselineSubscriptions = new Map(managedSessions.map((s) => [s.roleId, s.activeSubscriptionCount]));
      for (const session of managedSessions) {
        expect(baselineSubscriptions.get(session.roleId)).toBeGreaterThan(0);
      }

      const rssAfterRoundBytes: number[] = [];
      let turn = 0;

      for (let round = 0; round < ROUNDS; round += 1) {
        for (let i = 0; i < TURNS_PER_ROUND; i += 1) {
          const session = managedSessions[turn % managedSessions.length]!;
          const fake = fakeSessions.get(session.roleId)!;
          const taskId = `task-${turn}`;

          let updateCount = 0;
          const unsubscribe = session.subscribe(() => {
            updateCount += 1;
          });

          await manager.prompt(session.roleId, taskId, `turn ${turn}`);
          fake.emitTurnEvents();
          unsubscribe();

          expect(updateCount).toBe(UPDATES_EXPECTED_PER_TURN);
          // The core leak check, on every single turn: subscribing then
          // unsubscribing must always return this exact session to its
          // fixed baseline -- never growing turn over turn.
          expect(session.activeSubscriptionCount).toBe(baselineSubscriptions.get(session.roleId));

          turn += 1;
          if (turn % 100 === 0) {
            // Let the flush-interval timers and any other pending
            // macrotasks actually run periodically, matching how this
            // manager behaves under real (non-tight-loop) usage.
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
        rssAfterRoundBytes.push(forceGcAndMeasureRssBytes());
      }

      // Belt-and-braces final check across all four, after all 1,000 turns.
      for (const session of managedSessions) {
        expect(session.activeSubscriptionCount).toBe(baselineSubscriptions.get(session.roleId));
      }

      // RSS growth must stabilize, not accumulate: compare growth across
      // the *later* rounds (past initial warmup -- JIT, first allocations)
      // against a fixed absolute cap. This is a real, failing assertion --
      // an unbounded per-turn leak would clearly blow past it.
      const warmedUpBaselineBytes = rssAfterRoundBytes[0]!;
      const finalRssBytes = rssAfterRoundBytes[ROUNDS - 1]!;
      const growthAfterWarmupBytes = finalRssBytes - warmedUpBaselineBytes;

      // "," not "|": this value is spliced straight into a markdown table
      // cell by scripts/benchmark-runtime.sh -- a literal "|" would be
      // read as an extra table-column separator and break the row.
      console.log(`PERF_METRIC session_memory_rss_after_round_bytes ${rssAfterRoundBytes.join(",")} bytes`);
      console.log(`PERF_METRIC session_memory_growth_after_warmup_bytes ${growthAfterWarmupBytes} bytes`);

      expect(growthAfterWarmupBytes).toBeLessThan(MAX_RSS_GROWTH_AFTER_WARMUP_BYTES);
    },
    30_000,
  );
});
