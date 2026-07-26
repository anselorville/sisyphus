/**
 * Runtime telemetry: event-loop lag, RSS, queue depth, and DB request
 * latency, sampled on an interval and persisted through the DB Worker.
 *
 * The sampling/recording pass itself never performs a synchronous DB write
 * -- `sampleNow()` only ever reaches SQLite through `DatabaseClient.request()`,
 * an async postMessage round trip to the Worker Thread (see
 * ../storage/database.ts and ../storage/db-worker.ts). Nothing here ever
 * imports `better-sqlite3`.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

import type { DatabaseClient } from "../storage/database.js";

export interface PercentileSample {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface DbLatencySample {
  readonly p50: number;
  readonly p95: number;
  readonly sampleCount: number;
}

export interface MetricsSnapshot {
  readonly takenAt: string;
  readonly eventLoopLagMs: PercentileSample;
  readonly rssBytes: number;
  readonly queueDepths: Readonly<Record<string, number>>;
  readonly dbLatencyMs: DbLatencySample | undefined;
}

export interface RuntimeMetricsOptions {
  readonly db: DatabaseClient;
  /** How often to sample and persist a snapshot. Default 10s per the sidecar plan. */
  readonly sampleIntervalMs?: number;
  /** Passed straight to `monitorEventLoopDelay`. Default 10ms per the sidecar plan. */
  readonly eventLoopResolutionMs?: number;
  /** Bounded ring-buffer size for DB latency samples. */
  readonly maxDbLatencySamples?: number;
  /** Bounded cap on registered queue-depth gauges. */
  readonly maxQueueGauges?: number;
  /** Test/observability hook: called with every snapshot, before it's persisted. */
  readonly onSample?: (snapshot: MetricsSnapshot) => void;
  /** Called if persisting a snapshot through the DB Worker fails; a persistence hiccup must never crash the sampling timer. */
  readonly onPersistError?: (error: unknown) => void;
}

export class RuntimeMetricsGaugeCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeMetricsGaugeCapacityError";
  }
}

const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
const DEFAULT_EVENT_LOOP_RESOLUTION_MS = 10;
const DEFAULT_MAX_DB_LATENCY_SAMPLES = 500;
const DEFAULT_MAX_QUEUE_GAUGES = 64;
const NS_PER_MS = 1_000_000;

export class RuntimeMetrics {
  private readonly db: DatabaseClient;
  private readonly sampleIntervalMs: number;
  private readonly maxDbLatencySamples: number;
  private readonly maxQueueGauges: number;
  private readonly onSample: ((snapshot: MetricsSnapshot) => void) | undefined;
  private readonly onPersistError: ((error: unknown) => void) | undefined;
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>;
  private readonly queueGauges = new Map<string, () => number>();
  private readonly dbLatencySamples: number[] = [];
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(options: RuntimeMetricsOptions) {
    this.db = options.db;
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.maxDbLatencySamples = options.maxDbLatencySamples ?? DEFAULT_MAX_DB_LATENCY_SAMPLES;
    this.maxQueueGauges = options.maxQueueGauges ?? DEFAULT_MAX_QUEUE_GAUGES;
    this.onSample = options.onSample;
    this.onPersistError = options.onPersistError;
    this.histogram = monitorEventLoopDelay({
      resolution: options.eventLoopResolutionMs ?? DEFAULT_EVENT_LOOP_RESOLUTION_MS,
    });
  }

  /** Starts the event-loop histogram and the periodic sampling timer. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.histogram.enable();
    this.timer = setInterval(() => {
      void this.sampleNow();
    }, this.sampleIntervalMs);
    this.timer.unref();
  }

  /** Release path: stops the timer and disables the histogram. Idempotent, safe even if `start()` was never called. */
  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.histogram.disable();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Registers a named queue-depth gauge polled on every snapshot. Bounded: throws once `maxQueueGauges` distinct names are registered. */
  registerQueueDepthGauge(name: string, gauge: () => number): void {
    if (!this.queueGauges.has(name) && this.queueGauges.size >= this.maxQueueGauges) {
      throw new RuntimeMetricsGaugeCapacityError(
        `cannot register queue depth gauge "${name}": already at the cap of ${this.maxQueueGauges} registered gauges`,
      );
    }
    this.queueGauges.set(name, gauge);
  }

  /** Release path for a registered gauge (e.g. when a connection/queue it was observing goes away). */
  unregisterQueueDepthGauge(name: string): void {
    this.queueGauges.delete(name);
  }

  /** Records one DatabaseClient.request() round-trip latency sample (ms). Bounded ring buffer -- oldest sample drops once `maxDbLatencySamples` is reached. */
  recordDbLatency(ms: number): void {
    this.dbLatencySamples.push(ms);
    if (this.dbLatencySamples.length > this.maxDbLatencySamples) {
      this.dbLatencySamples.shift();
    }
  }

  /** Computes a snapshot synchronously from current in-process state. Pure/no I/O -- does not touch the DB Worker. */
  snapshot(): MetricsSnapshot {
    const queueDepths: Record<string, number> = {};
    for (const [name, gauge] of this.queueGauges) {
      queueDepths[name] = gauge();
    }

    return {
      takenAt: new Date().toISOString(),
      eventLoopLagMs: {
        p50: safeMs(this.histogram.percentile(50)),
        p95: safeMs(this.histogram.percentile(95)),
        p99: safeMs(this.histogram.percentile(99)),
      },
      rssBytes: process.memoryUsage().rss,
      queueDepths,
      dbLatencyMs: summarizeLatency(this.dbLatencySamples),
    };
  }

  /**
   * Takes one sampling pass, resets the event-loop histogram for the next
   * window, and persists the snapshot through the DB Worker -- never a
   * synchronous DB write on this or any thread. Public (not just driven by
   * the internal timer) so callers/tests can trigger a pass on demand
   * without waiting on the real interval.
   */
  async sampleNow(): Promise<MetricsSnapshot> {
    const snapshot = this.snapshot();
    this.onSample?.(snapshot);
    this.histogram.reset();

    try {
      await this.db.request({
        type: "metrics.record",
        sample: {
          recordedAt: snapshot.takenAt,
          eventLoopP50Ms: snapshot.eventLoopLagMs.p50,
          eventLoopP95Ms: snapshot.eventLoopLagMs.p95,
          eventLoopP99Ms: snapshot.eventLoopLagMs.p99,
          rssBytes: snapshot.rssBytes,
          queueDepth: snapshot.queueDepths,
          dbLatencyP50Ms: snapshot.dbLatencyMs?.p50 ?? null,
          dbLatencyP95Ms: snapshot.dbLatencyMs?.p95 ?? null,
          dbLatencySampleCount: snapshot.dbLatencyMs?.sampleCount ?? 0,
        },
      });
    } catch (error) {
      this.onPersistError?.(error);
    }

    return snapshot;
  }
}

function safeMs(nanoseconds: number): number {
  return Number.isFinite(nanoseconds) ? nanoseconds / NS_PER_MS : 0;
}

function summarizeLatency(samples: readonly number[]): DbLatencySample | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentileOf(sorted, 50),
    p95: percentileOf(sorted, 95),
    sampleCount: samples.length,
  };
}

function percentileOf(sortedAscending: readonly number[], p: number): number {
  const index = Math.min(sortedAscending.length - 1, Math.ceil((p / 100) * sortedAscending.length) - 1);
  return sortedAscending[Math.max(0, index)] ?? 0;
}
