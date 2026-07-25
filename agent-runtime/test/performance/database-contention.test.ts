/**
 * Task 19: SQLite slow-write / lock-contention fault injection -- section
 * 15.6's requirement that slow writes and lock contention be verified, via
 * fault injection, to never block the voice path.
 *
 * Fault-injection approach (see also src/storage/database.ts's
 * `DatabaseClientOptions.testOnlyTransactionDelayMs` and
 * src/storage/db-worker.ts's `applyTestOnlyTransactionDelay`): rather than
 * trying to force real write contention hard enough to reliably produce a
 * ~100ms transaction on every machine this suite runs on (unpredictable,
 * not CI-safe), a minimal test-only knob blocks the DB Worker thread for a
 * fixed number of ms per applied write batch via `Atomics.wait` -- a real,
 * synchronous, precise stall on the *worker* thread, never the main thread.
 * This test's whole point is proving that stall is invisible to (a) the
 * main thread's own event loop and (b) a DB-independent critical path, so a
 * deterministic, exact delay is more useful here than a best-effort
 * approximation of contention.
 *
 * The cancel-equivalent path: `voice.speech.cancel` normally flows
 * Python -> sidecar (Python's local VAD stops TTS locally, then notifies
 * the swarm) -- i.e. *inbound* over RuntimeWebSocketServer. Delivering that
 * event and its ack never touches `db.request()` at all (see
 * websocket-server.ts's `handleInboundMessage`: the ack is sent
 * unconditionally after `onInboundEvent` -- left unwired/no-op here,
 * matching how a bare cancel event is actually routed today;
 * createInboundEventRouter only ever acts on voice.transcript.final). The
 * property under test is the transport layer's own independence from the
 * DB, not any particular business handler's speed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RealtimeEvent } from "../../src/protocol/events.js";
import { encodeEvent } from "../../src/protocol/schema.js";
import { DatabaseClient } from "../../src/storage/database.js";
import { RuntimeMetrics } from "../../src/telemetry/runtime-metrics.js";
import { RuntimeWebSocketServer } from "../../src/transport/websocket-server.js";
import type { AckMessage } from "../../src/transport/websocket-server.js";

const TRANSACTION_DELAY_MS = 100;
// Well under TRANSACTION_DELAY_MS -- if the cancel ack were ever queued
// behind even one slow transaction, it could not possibly land under this.
const CANCEL_ACK_BUDGET_MS = 50;
const EVENT_LOOP_LAG_P95_BUDGET_MS = 20; // section 15.5
const SUSTAINED_CONTENTION_WINDOW_MS = 800;
const DB_WRITE_GAP_MS = 20; // gap between sequential delayed transactions, so each lands in its own batch

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-db-contention-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function once<T = unknown>(target: WebSocket, event: string): Promise<T> {
  return new Promise((resolve) => target.once(event, (arg: T) => resolve(arg)));
}

async function connectClient(port: number): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, "open");
  return client;
}

function parseAck(raw: unknown): AckMessage {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return JSON.parse(text) as AckMessage;
}

function cancelEquivalentEvent(sequence: number): RealtimeEvent {
  return {
    event_id: `evt-cancel-${sequence}`,
    sequence,
    source: "pipecat",
    type: "voice.speech.cancel",
    timestamp: new Date().toISOString(),
    payload: {},
  };
}

describe("DB Worker contention never blocks the main thread or the cancel path", () => {
  it("acks a cancel-equivalent event fast while a slow DB transaction is provably still in flight", async () => {
    const db = await DatabaseClient.open(join(tempDir, "contention.sqlite3"), {
      testOnlyTransactionDelayMs: TRANSACTION_DELAY_MS,
    });
    const server = new RuntimeWebSocketServer({ port: 0 });
    await server.start();
    let client: WebSocket | undefined;

    try {
      client = await connectClient(server.address!.port);

      // Fire a real db.request() (a real RuntimeMetrics sample -- the exact
      // path production code uses) and deliberately do NOT await it yet:
      // the worker thread starts its artificial 100ms stall right away, so
      // for the next 100ms this promise is *provably* still pending by
      // construction, not by timing luck.
      const metrics = new RuntimeMetrics({ db });
      const slowWrite = metrics.sampleNow();

      const ackPromise = once<Buffer>(client, "message");
      const sendStartedAt = performance.now();
      client.send(encodeEvent(cancelEquivalentEvent(1)));
      const ack = parseAck(await ackPromise);
      const ackLatencyMs = performance.now() - sendStartedAt;

      expect(ack).toEqual({ kind: "ack", sequence: 1, duplicate: false });
      expect(ackLatencyMs).toBeLessThan(CANCEL_ACK_BUDGET_MS);

      await slowWrite; // clean up: don't leave the first sample dangling

      console.log(`PERF_METRIC db_contention_cancel_ack_ms ${ackLatencyMs.toFixed(3)} ms`);
    } finally {
      client?.close();
      await server.close();
      await db.close();
    }
  });

  it("keeps Node's own event-loop lag p95 under the 20ms budget while a sustained sequence of ~100ms DB transactions runs", async () => {
    const db = await DatabaseClient.open(join(tempDir, "contention-sustained.sqlite3"), {
      testOnlyTransactionDelayMs: TRANSACTION_DELAY_MS,
    });
    const metrics = new RuntimeMetrics({ db, eventLoopResolutionMs: 5 });
    metrics.start();

    let keepContending = true;
    let transactionsCompleted = 0;
    const contentionLoop = (async () => {
      while (keepContending) {
        await metrics.sampleNow(); // each is its own ~100ms-delayed transaction
        transactionsCompleted += 1;
        await new Promise((resolve) => setTimeout(resolve, DB_WRITE_GAP_MS));
      }
    })();

    try {
      await new Promise((resolve) => setTimeout(resolve, SUSTAINED_CONTENTION_WINDOW_MS));
    } finally {
      keepContending = false;
      await contentionLoop;
      metrics.stop();
      await db.close();
    }

    // Several sequential ~100ms transactions really did run back to back --
    // this is genuinely sustained contention, not a single blip.
    expect(transactionsCompleted).toBeGreaterThanOrEqual(3);

    const snapshot = metrics.snapshot();
    expect(snapshot.eventLoopLagMs.p95).toBeLessThan(EVENT_LOOP_LAG_P95_BUDGET_MS);

    console.log(`PERF_METRIC db_contention_event_loop_lag_p50_ms ${snapshot.eventLoopLagMs.p50.toFixed(3)} ms`);
    console.log(`PERF_METRIC db_contention_event_loop_lag_p95_ms ${snapshot.eventLoopLagMs.p95.toFixed(3)} ms`);
    console.log(`PERF_METRIC db_contention_transactions_completed ${transactionsCompleted} transactions`);
  });
});
