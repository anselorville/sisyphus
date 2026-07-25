/**
 * Task 19: RuntimeMetrics' real event-loop-lag tracking, under a realistic
 * load pattern -- section 15.5's "Node event-loop lag p95 < 20ms" budget.
 *
 * No existing test file exercises RuntimeMetrics at all -- this is the
 * first. Every piece here is real: a real DatabaseClient (a real Worker
 * Thread, a real SQLite file on disk), a real RuntimeWebSocketServer with
 * several real `ws` client connections (standing in for the "four active
 * resident sessions" section 15.5 sizes its RSS/event-loop budgets around),
 * and a real RuntimeMetrics wired to both exactly as src/index.ts's
 * composition root does. This test only drives load through the real
 * system and reads RuntimeMetrics' own snapshot() -- it never reimplements
 * event-loop-lag measurement (that's Node's native monitorEventLoopDelay,
 * wrapped unmodified by RuntimeMetrics).
 *
 * database-contention.test.ts covers the *adversarial* DB-slowness angle
 * specifically; this file's job is the more ordinary "realistic sustained
 * load" angle: broadcasting a steady stream of task-progress-shaped events
 * to several connections while periodically sampling metrics (a real,
 * un-delayed DB write each time), and confirming Node's own event loop
 * never accumulates lag beyond budget.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RealtimeEvent } from "../../src/protocol/events.js";
import { DatabaseClient } from "../../src/storage/database.js";
import { RuntimeMetrics } from "../../src/telemetry/runtime-metrics.js";
import { RuntimeWebSocketServer } from "../../src/transport/websocket-server.js";

// Mirrors section 15.5's own framing: budgets are sized around four
// concurrently active resident sessions, each with its own connection.
const CONNECTED_CLIENTS = 4;
const LOAD_DURATION_MS = 1_200;
const BROADCASTS_PER_TICK = 5;
const EVENT_LOOP_LAG_P95_BUDGET_MS = 20; // section 15.5

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-runtime-event-loop-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeProgressEvent(sequence: number, taskId: string): RealtimeEvent {
  return {
    event_id: `evt-${sequence}`,
    sequence,
    task_id: taskId,
    source: "swarm",
    type: "task.progress",
    timestamp: new Date().toISOString(),
    payload: { percent: sequence % 100 },
  };
}

function once(target: WebSocket, event: string): Promise<void> {
  return new Promise((resolve) => target.once(event, () => resolve()));
}

async function connectClient(port: number): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, "open");
  return client;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("event-loop lag under realistic load", () => {
  it("keeps Node's own event-loop lag p95 under the 20ms budget while broadcasting to several connections and issuing real DB writes concurrently", async () => {
    const db = await DatabaseClient.open(join(tempDir, "metrics.sqlite3"));
    const server = new RuntimeWebSocketServer({ port: 0 });
    await server.start();

    const metrics = new RuntimeMetrics({ db, eventLoopResolutionMs: 5 });
    metrics.registerQueueDepthGauge("websocket_outbound", () => server.totalQueueDepth);
    metrics.start();

    const clients: WebSocket[] = [];
    try {
      for (let i = 0; i < CONNECTED_CLIENTS; i += 1) {
        const client = await connectClient(server.address!.port);
        client.on("message", () => {}); // drain so the server side never backs up on us
        clients.push(client);
      }

      const deadline = Date.now() + LOAD_DURATION_MS;
      let sequence = 0;
      let dbSamplesTaken = 0;

      while (Date.now() < deadline) {
        for (let i = 0; i < BROADCASTS_PER_TICK; i += 1) {
          sequence += 1;
          server.broadcast(makeProgressEvent(sequence, `task-${sequence % 8}`));
        }

        if (sequence % 25 === 0) {
          // A real DB round trip through the exact path production code
          // uses -- never a synchronous write on this thread.
          await metrics.sampleNow();
          dbSamplesTaken += 1;
        } else {
          await tick();
        }
      }

      // A realistic voice-agent load pattern is bursty, not constant --
      // give the histogram a bit of idle time too before the final read.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const snapshot = metrics.snapshot();

      expect(dbSamplesTaken).toBeGreaterThan(0);
      expect(sequence).toBeGreaterThan(0);
      expect(snapshot.rssBytes).toBeGreaterThan(0);
      expect(snapshot.queueDepths.websocket_outbound).toBeDefined();
      expect(snapshot.eventLoopLagMs.p95).toBeLessThan(EVENT_LOOP_LAG_P95_BUDGET_MS);

      console.log(`PERF_METRIC node_event_loop_lag_p50_ms ${snapshot.eventLoopLagMs.p50.toFixed(3)} ms`);
      console.log(`PERF_METRIC node_event_loop_lag_p95_ms ${snapshot.eventLoopLagMs.p95.toFixed(3)} ms`);
      console.log(`PERF_METRIC node_event_loop_lag_p99_ms ${snapshot.eventLoopLagMs.p99.toFixed(3)} ms`);
      console.log(`PERF_METRIC node_rss_bytes ${snapshot.rssBytes} bytes`);
    } finally {
      metrics.stop();
      for (const client of clients) {
        client.close();
      }
      await server.close();
      await db.close();
    }
  });
});
