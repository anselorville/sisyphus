/**
 * Composition root for the agent-runtime sidecar (Task 17).
 *
 * This file's only job is to construct every piece Tasks 7-16 already built
 * and wire their callbacks/event flow together, then register a clean
 * shutdown order -- no business logic of its own. The one deliberate
 * exception (per this task's own spec) is routing an inbound
 * `voice.transcript.final` RealtimeEvent into a durable Task Nest entry,
 * which itself lives in its own small module (./tasks/inbound-event-router.js),
 * not inline here.
 *
 * `createAgentRuntime()` is importable and startable in-process (no
 * subprocess required), so integration tests can start/stop a real instance
 * directly -- see test/integration/recovery.test.ts. When this module is run
 * directly (`node dist/index.js`), the bottom of the file boots one instance
 * from environment-derived config (see ./config.ts) and wires SIGINT/SIGTERM
 * to a graceful shutdown; that is the real subprocess entry point a
 * companion Python-side task launches and health-checks.
 *
 * Wiring order (fixed by this task's spec): config -> DatabaseClient.open()
 * -> RuntimeMetrics -> RuntimeWebSocketServer -> RoleManifestRegistry
 * (all 7 manifests) -> PiRoleSessionManager -> TaskNest ->
 * CapabilityGateway+DiplomacyOfficer -> the routing/voice layer -> economy
 * -> ecology (PopulationRegistry, Queen, GeneBank, RoleIncubator,
 * PheromoneMap) -> RpcChamber. Inspector and MemoryCurator (Task 16) are
 * also constructed, one step after RpcChamber: they are not named in this
 * task's own ordered wiring list, but the task's own "complete inventory"
 * flags them as existing Task 16 deliverables, and leaving two whole
 * modules completely unconstructed by the "wire everything into one
 * running process" composition root seemed like an oversight worth
 * closing rather than repeating -- both are side-effect-free to construct
 * and need no shutdown of their own (see the final report for this
 * flagged as a deliberate, documented deviation).
 *
 * Startup never requires real Pi/LLM provider credentials: registering a
 * RoleManifest and constructing PiRoleSessionManager never builds a Pi
 * Session -- that only happens lazily, the moment something actually calls
 * ensure()/prompt() for a given role (see ./roles/session-manager.ts).
 * Resident Pi Sessions all share this one Node process; only isolated/trial
 * roles ever use RpcChamber's separate OS processes, and RpcChamber.spawn()
 * is likewise never called at startup.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { config as defaultConfig, type AgentRuntimeConfig } from "./config.js";
import type { RealtimeEvent } from "./protocol/events.js";
import { RuntimeWebSocketServer } from "./transport/websocket-server.js";
import { RuntimeMetrics } from "./telemetry/runtime-metrics.js";
import { DatabaseClient } from "./storage/database.js";
import { TaskNest, type TaskRecord } from "./tasks/task-nest.js";
import { createInboundEventRouter } from "./tasks/inbound-event-router.js";
import { RoleManifestRegistry } from "./roles/registry.js";
import { PiRoleSessionManager, createDefaultPiSessionProvider } from "./roles/session-manager.js";
import type { PiSessionProvider } from "./roles/types.js";
import {
  GENERAL_ROLE_MANIFEST,
  CODE_ROLE_MANIFEST,
  WEB_ROLE_MANIFEST,
  DEVICE_ROLE_MANIFEST,
  MAIL_ROLE_MANIFEST,
  INSPECTOR_ROLE_MANIFEST,
  MEMORY_ROLE_MANIFEST,
} from "./roles/manifests.js";
import { CapabilityGateway } from "./tools/capability-gateway.js";
import { DiplomacyOfficer } from "./tools/diplomacy-officer.js";
import { ReflexRouter } from "./routing/reflex-router.js";
import { TrafficCommander } from "./voice/traffic-commander.js";
import { VoiceHerald } from "./voice/voice-herald.js";
import { ApiBudgetLedger } from "./economy/api-budget.js";
import { ProviderRouter } from "./economy/provider-router.js";
import { PopulationRegistry } from "./ecology/population.js";
import { Queen } from "./ecology/queen.js";
import { GeneBank } from "./ecology/gene-bank.js";
import { RoleIncubator } from "./ecology/role-incubator.js";
import { PheromoneMap } from "./ecology/pheromone-map.js";
import { RpcChamber } from "./isolation/rpc-chamber.js";
import { Inspector } from "./inspection/inspector.js";
import { MemoryCurator } from "./memory/memory-curator.js";

const ALL_ROLE_MANIFESTS = [
  GENERAL_ROLE_MANIFEST,
  CODE_ROLE_MANIFEST,
  WEB_ROLE_MANIFEST,
  DEVICE_ROLE_MANIFEST,
  MAIL_ROLE_MANIFEST,
  INSPECTOR_ROLE_MANIFEST,
  MEMORY_ROLE_MANIFEST,
];

export interface CreateAgentRuntimeOptions {
  /** Overrides config.dbPath (e.g. a temp file in tests). */
  readonly dbPath?: string;
  /** Overrides config.port. Use 0 for an OS-assigned ephemeral port (see server.address). */
  readonly port?: number;
  /** Overrides the production createDefaultPiSessionProvider() -- inject a fake in tests so nothing ever touches a real Pi backend. */
  readonly piSessionProvider?: PiSessionProvider;
  /** Injectable clock, forwarded to TaskNest. Default: the real wall clock. */
  readonly now?: () => Date;
  /**
   * Whether startup automatically calls TaskNest.recoverPending() before the
   * WebSocket server starts accepting connections. Default true: a freshly
   * started process should always pick up whatever SQLite still holds
   * durable from before a prior crash/restart. See recoveredTasks below and
   * test/integration/recovery.test.ts.
   */
  readonly autoRecoverPending?: boolean;
}

/** Every constructed piece of the composed runtime, plus a single ordered close(). */
export interface AgentRuntime {
  readonly config: AgentRuntimeConfig;
  readonly db: DatabaseClient;
  readonly metrics: RuntimeMetrics;
  readonly server: RuntimeWebSocketServer;
  readonly roleRegistry: RoleManifestRegistry;
  readonly sessionManager: PiRoleSessionManager;
  readonly taskNest: TaskNest;
  readonly capabilityGateway: CapabilityGateway;
  readonly diplomacyOfficer: DiplomacyOfficer;
  readonly reflexRouter: ReflexRouter;
  readonly trafficCommander: TrafficCommander;
  readonly voiceHerald: VoiceHerald;
  readonly apiBudget: ApiBudgetLedger;
  readonly providerRouter: ProviderRouter;
  readonly population: PopulationRegistry;
  readonly queen: Queen;
  readonly geneBank: GeneBank;
  readonly roleIncubator: RoleIncubator;
  readonly pheromoneMap: PheromoneMap;
  readonly rpcChamber: RpcChamber;
  readonly inspector: Inspector;
  readonly memoryCurator: MemoryCurator;
  /** Tasks reloaded from SQLite during startup (empty unless autoRecoverPending, default true, found something to recover). */
  readonly recoveredTasks: readonly TaskRecord[];
  /**
   * Ordered shutdown: (1) stop accepting new inbound work, (2) close the
   * WebSocket server, (3) close the SessionManager and RpcChamber, (4) close
   * the DB Worker last. Idempotent.
   */
  close(): Promise<void>;
}

/**
 * Builds and starts one complete agent-runtime instance: every module Tasks
 * 7-16 built, wired together, listening for connections. Never throws due to
 * missing Pi/LLM provider credentials -- those are only ever needed the
 * moment a role session is actually prompted, never at construction time.
 */
export async function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): Promise<AgentRuntime> {
  const runtimeConfig: AgentRuntimeConfig = Object.freeze({
    ...defaultConfig,
    port: options.port ?? defaultConfig.port,
    dbPath: options.dbPath ?? defaultConfig.dbPath,
  });

  await mkdir(dirname(runtimeConfig.dbPath), { recursive: true });

  // Startup rollback stack: used only if construction fails partway through
  // (e.g. the WebSocket port is already bound), so a failed startup never
  // leaks the DB Worker's OS thread or a running metrics timer. Runs in
  // reverse (last-opened-first-closed) -- the same discipline as close()'s
  // documented shutdown order below.
  const rollbacks: Array<() => Promise<void>> = [];
  async function rollback(): Promise<void> {
    for (const step of rollbacks.reverse()) {
      await step().catch(() => {});
    }
  }

  try {
    // 1. DB Worker. `metricsRef` breaks the construction-order cycle: this
    // callback is wired before RuntimeMetrics exists, but is only ever
    // invoked (on a successful db.request()) once metricsRef.current is set.
    const metricsRef: { current: RuntimeMetrics | undefined } = { current: undefined };
    const db = await DatabaseClient.open(runtimeConfig.dbPath, {
      onLatencySample: (ms) => metricsRef.current?.recordDbLatency(ms),
    });
    rollbacks.push(() => db.close());

    // 2. RuntimeMetrics.
    const metrics = new RuntimeMetrics({ db });
    metricsRef.current = metrics;
    metrics.start();
    rollbacks.push(async () => metrics.stop());

    // 3. RuntimeWebSocketServer. `routeInboundEvent`/`acceptingInboundWork`
    // are forward references: TaskNest (step 6) does not exist yet, but this
    // handler is only ever invoked once a client connects, which cannot
    // happen before server.start() runs at the very end of this function.
    let acceptingInboundWork = true;
    let routeInboundEvent: (event: RealtimeEvent, connectionId: string) => Promise<void> = async () => {};

    const server = new RuntimeWebSocketServer({
      port: runtimeConfig.port,
      onInboundEvent: (event, connectionId) => {
        if (!acceptingInboundWork) {
          return;
        }
        return routeInboundEvent(event, connectionId);
      },
    });
    rollbacks.push(() => server.close());
    // Documented expectation from websocket-server.ts's own module comment:
    // "the telemetry gauge callers are expected to register".
    metrics.registerQueueDepthGauge("websocket_outbound", () => server.totalQueueDepth);

    // 4. RoleManifestRegistry -- all 7 manifests.
    const roleRegistry = new RoleManifestRegistry();
    for (const manifest of ALL_ROLE_MANIFESTS) {
      roleRegistry.register(manifest);
    }

    // 5. PiRoleSessionManager. Building the default provider does no I/O and
    // needs no credentials (see the module doc comment); only ensure()/
    // prompt() ever touches a real Pi backend, and this composition root
    // never calls either at startup.
    const piSessionProvider = options.piSessionProvider ?? createDefaultPiSessionProvider();
    const sessionManager = new PiRoleSessionManager({ registry: roleRegistry, provider: piSessionProvider });
    rollbacks.push(() => sessionManager.close());

    // 6. TaskNest -- now routeInboundEvent can be given its real target.
    const taskNest = new TaskNest({ db, now: options.now });
    routeInboundEvent = createInboundEventRouter(taskNest);

    // 7. CapabilityGateway + DiplomacyOfficer. Default classifier
    // (DiplomacyOfficer's own fail-safe: always ELEVATE the one genuinely
    // ambiguous rule case) -- never wiring a real Pi classifier is explicitly
    // sanctioned by diplomacy-officer.ts's own doc comment for this stage.
    const diplomacyOfficer = new DiplomacyOfficer();
    const capabilityGateway = new CapabilityGateway({ officer: diplomacyOfficer });

    // 8. Routing/voice layer.
    const reflexRouter = new ReflexRouter();
    const trafficCommander = new TrafficCommander();
    const voiceHerald = new VoiceHerald();

    // 9. Economy.
    const apiBudget = new ApiBudgetLedger({
      dailyLimitUsd: runtimeConfig.apiBudgetDailyLimitUsd,
      voiceReserveUsd: runtimeConfig.apiBudgetVoiceReserveUsd,
    });
    const providerRouter = new ProviderRouter();

    // 10. Ecology.
    const population = new PopulationRegistry();
    const queen = new Queen();
    const geneBank = new GeneBank();
    const roleIncubator = new RoleIncubator();
    const pheromoneMap = new PheromoneMap();

    // 11. RpcChamber -- constructing it never spawns a process; only
    // spawn() does, and nothing at startup calls it. capacity is driven by
    // PopulationRegistry.isolationCap (the single source of truth for the
    // isolation ceiling) rather than RpcChamber's own default, so the two
    // can never drift apart -- see README.md's roadmap item on unifying
    // them.
    const rpcChamber = new RpcChamber({ capacity: population.isolationCap });
    rollbacks.push(() => rpcChamber.close());

    // 12. Inspector + MemoryCurator (Task 16) -- see the module doc comment
    // for why these are included despite not being named in this task's own
    // ordered wiring list. Both are pure, side-effect-free, and own no
    // resource that needs releasing.
    const inspector = new Inspector();
    const memoryCurator = new MemoryCurator();

    // Recovery: reload whatever SQLite still holds durable from a prior
    // crash/restart before this instance ever accepts a connection.
    const recoveredTasks = options.autoRecoverPending === false ? [] : await taskNest.recoverPending();

    await server.start();

    let closed = false;
    async function close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;

      // 1. Stop accepting new inbound work: no more realtime events are
      // routed into the Task Nest, and the periodic metrics sampler (which
      // itself issues a request to the DB Worker on every tick) stops
      // before anything below starts tearing down.
      acceptingInboundWork = false;
      metrics.stop();

      // 2. Close the WebSocket server: no more inbound frames, no more
      // queued outbound delivery.
      await server.close();

      // 3. Close the SessionManager and RpcChamber: dispose every resident
      // Pi Session and terminate any isolated-role child process.
      await Promise.all([sessionManager.close(), rpcChamber.close()]);

      // 4. Close the DB Worker last -- everything above may still need to
      // read or write through `db` while it unwinds.
      await db.close();
    }

    return {
      config: runtimeConfig,
      db,
      metrics,
      server,
      roleRegistry,
      sessionManager,
      taskNest,
      capabilityGateway,
      diplomacyOfficer,
      reflexRouter,
      trafficCommander,
      voiceHerald,
      apiBudget,
      providerRouter,
      population,
      queen,
      geneBank,
      roleIncubator,
      pheromoneMap,
      rpcChamber,
      inspector,
      memoryCurator,
      recoveredTasks,
      close,
    };
  } catch (error) {
    await rollback();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Subprocess entry point: `node dist/index.js`. Reads config from
// environment variables only (see ./config.ts) -- no CLI args. Prints one
// stable, grep-able line on success so an external health-check (the
// companion Python-side task's launcher) can detect it, and shuts down
// gracefully on SIGINT/SIGTERM.
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  const runtime = await createAgentRuntime();
  const address = runtime.server.address;
  console.log(`[agent-runtime] listening on ${address?.host ?? "127.0.0.1"}:${address?.port ?? "unknown"}`);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[agent-runtime] received ${signal}, shutting down`);
    runtime
      .close()
      .then(() => {
        console.log("[agent-runtime] shutdown complete");
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error("[agent-runtime] error during shutdown", error);
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error("[agent-runtime] fatal error during startup", error);
    process.exit(1);
  });
}
