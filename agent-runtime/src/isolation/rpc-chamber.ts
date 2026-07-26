/**
 * RPC Chamber: the swarm's isolation mechanism for a brand-new/unverified
 * role, a Temporary Intelligence Caste, or a Tool Scout's first use of an
 * unfamiliar tool -- design doc sections 4.2 and 8.3. Each spawn() starts a
 * genuinely separate `pi --mode rpc` OS process (never a resident role in
 * this Node process's own RoleSessionManager, ../roles/session-manager.ts)
 * so a misbehaving new role can never take down anything else.
 *
 * First-release hard constraint (design doc 4.2: "同一时间默认只允许一个
 * 隔离舱任务。该限制属于人口约束，不属于 LLM 资源经济。" -- "only one
 * isolation-chamber task is allowed at a time by default; this is a
 * population constraint, not an LLM resource-economy one"): at most
 * `capacity` (default 1) isolated roles may be running at once. This is
 * this chamber's OWN concurrency ceiling, enforced directly here as a
 * constructor option rather than a hardcoded constant -- production
 * (../index.ts) passes `PopulationRegistry.isolationCap` so that value is
 * the single source of truth and the two can never drift apart; a caller
 * that constructs a bare `new RpcChamber()` (e.g. tests) still gets
 * DEFAULT_CAPACITY (1), matching population.ts's own default.
 *
 * Wire protocol: this module's outbound {id, type: "prompt"|"abort", ...}
 * and inbound {id, type: "response", command, success, error?} shapes are
 * not invented -- they are the real `pi --mode rpc` protocol, verified
 * against the installed
 * node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts
 * and docs/rpc.md ("All commands support an optional id field for
 * request/response correlation. If provided, the corresponding response
 * will include the same id."). This task's scope only ever sends
 * prompt/abort and only ever reads each command's own {type:"response"}
 * line; the much larger real event stream (message_update,
 * tool_execution_*, agent_end, ...) is real but out of scope for this
 * task's minimal spawn/prompt/abort/close surface -- a later task that
 * wants streamed isolated-role output can extend the stdout line handler
 * to branch on additional `type` values (e.g. feeding them through the same
 * PiEventAdapter, ../roles/pi-event-adapter.ts, resident roles already use)
 * without changing this module's public shape.
 *
 * Every stdout byte is framed with JsonlDecoder (./jsonl-decoder.ts) --
 * strict LF only, never node:readline. stderr is retained in a bounded
 * 1MiB ring buffer (StderrTail below) for post-mortem diagnostics, never
 * left to grow without bound.
 *
 * Timeout seam: like ../tools/mail/agently-mail.ts's injectable `sleep`,
 * RpcChamberOptions.scheduleTimeout is an injectable seam (default: real
 * setTimeout/clearTimeout) so tests can fire a pending request's timeout
 * synchronously and deterministically, without vi.useFakeTimers() or any
 * real wall-clock wait.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";

import { config as defaultConfig } from "../config.js";
import type { RoleGenome } from "../ecology/gene-bank.js";
import { validateGenome } from "../ecology/gene-bank.js";
import { resolveRoleModel } from "../roles/model-routing.js";
import type { ModelCatalog } from "../roles/model-routing.js";
import type { RoleModelClassRouting } from "../roles/types.js";
import type { JsonlRecord } from "./jsonl-decoder.js";
import { JsonlDecoder } from "./jsonl-decoder.js";

/**
 * Minimal structural slice of node:child_process's real ChildProcess this
 * module depends on -- a real ChildProcess satisfies this as-is (mirrors
 * ../roles/types.ts's PiSession doc comment: "no adapter/wrapper needed in
 * production"). Tests inject a fake implementation instead of spawning a
 * real `pi` process (mirrors test/tools/mail/agently-mail.test.ts's
 * FakeAgentlyCliTransport).
 */
export interface RpcChildProcess {
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): void };
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): void };
  readonly stdin: { write(chunk: string): boolean; end(): void };
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Builds the child process for one isolated genome -- may resolve asynchronously (see createPiRpcProcessSpawner(), which resolves the genome's modelPolicy before spawning). Production uses createPiRpcProcessSpawner(); tests inject a fake (sync or async). Mirrors PiSessionProvider's injectable-seam role (../roles/types.ts) for the isolated-process world. */
export type RpcProcessSpawner = (genome: RoleGenome) => RpcChildProcess | Promise<RpcChildProcess>;

export interface PiRpcProcessSpawnerOptions {
  /**
   * Which concrete provider/model each RoleModelClass tier resolves to --
   * same routing table resident roles use
   * (../roles/session-manager.ts's createDefaultPiSessionProvider()).
   * Default: config.modelClassRouting (../config.ts), overridable via env
   * vars.
   */
  readonly modelRouting?: RoleModelClassRouting;
  /**
   * Model catalog resolveRoleModel() checks each genome's modelPolicy.
   * preferredClass against (credential-checked, not just a static-catalog
   * id lookup) -- mirrors ../roles/session-manager.ts's ModelRuntime
   * handle. Inject a fake (satisfying ../roles/model-routing.ts's
   * ModelCatalog) in tests; default: one real `ModelRuntime.create({
   * authPath, modelsPath })`, built lazily on first use and reused for
   * every subsequent spawn so the auth/model catalog is only ever loaded
   * once per process.
   */
  readonly modelCatalog?: ModelCatalog;
  /** Global pi config directory, used only to locate auth.json/models.json for the default modelCatalog. Default: getAgentDir() (~/.pi/agent). */
  readonly agentDir?: string;
  /** Real command to spawn. Default "pi". */
  readonly command?: string;
  /** Base environment to restrict from. Default process.env. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Extra env var names (beyond the safe default allowlist) to pass through from baseEnv -- e.g. a provider's API key. */
  readonly allowedEnvVars?: readonly string[];
}

const DEFAULT_SAFE_ENV_VARS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

/**
 * Builds a restricted environment for a spawned isolation-chamber process:
 * only an explicit allowlist passes through from `baseEnv`, never the full
 * parent environment -- an unverified/new role's process should never
 * inherit secrets it has no stated need for.
 */
export function buildRestrictedEnv(
  baseEnv: NodeJS.ProcessEnv,
  allowedEnvVars: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([...DEFAULT_SAFE_ENV_VARS, ...allowedEnvVars]);
  const restricted: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = baseEnv[key];
    if (value !== undefined) {
      restricted[key] = value;
    }
  }
  return restricted;
}

/**
 * Production RpcProcessSpawner: spawns a real `pi --mode rpc` process via
 * an argument array (never a shell string) -- mirrors
 * ../tools/mail/agently-mail.ts's SpawnAgentlyCliTransport. Not exercised
 * by this task's tests (they inject a fake spawner); it's the real
 * implementation production code constructs RpcChamber with.
 *
 * Resolves each genome's own `modelPolicy.preferredClass` through the same
 * resolveRoleModel()/modelRouting path resident roles use
 * (../roles/session-manager.ts's createDefaultPiSessionProvider()), instead
 * of spawning every isolated genome against a fixed anthropic/default --
 * closes the "RpcChamber routing" gap named in ../README.md's roadmap. A
 * misconfigured tier throws UnresolvedRoleModelError (propagated out of
 * spawn(), never silently falling back to a different model).
 */
export function createPiRpcProcessSpawner(options: PiRpcProcessSpawnerOptions = {}): RpcProcessSpawner {
  const command = options.command ?? "pi";
  const modelRouting = options.modelRouting ?? defaultConfig.modelClassRouting;
  const agentDir = options.agentDir ?? getAgentDir();
  const env = buildRestrictedEnv(options.baseEnv ?? process.env, options.allowedEnvVars);

  let modelCatalogPromise: Promise<ModelCatalog> | undefined;
  const getModelCatalog = (): Promise<ModelCatalog> => {
    modelCatalogPromise ??= options.modelCatalog
      ? Promise.resolve(options.modelCatalog)
      : ModelRuntime.create({
          authPath: `${agentDir}/auth.json`,
          modelsPath: `${agentDir}/models.json`,
        });
    return modelCatalogPromise;
  };

  return async (genome: RoleGenome): Promise<RpcChildProcess> => {
    const catalog = await getModelCatalog();
    const resolved = await resolveRoleModel(catalog, genome.roleId, genome.modelPolicy.preferredClass, modelRouting);

    const child = nodeSpawn(
      command,
      ["--mode", "rpc", "--no-session", "--provider", resolved.provider, "--model", resolved.id],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      },
    );
    return child;
  };
}

const STDERR_CAP_BYTES = 1024 * 1024;

/** Bounded tail buffer for a chamber session's stderr -- keeps only the most recent STDERR_CAP_BYTES bytes, so a runaway/chatty isolated process's stderr can never grow this process's own memory without bound. */
class StderrTail {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > STDERR_CAP_BYTES) {
      this.buffer = this.buffer.subarray(this.buffer.length - STDERR_CAP_BYTES);
    }
  }

  toString(): string {
    return this.buffer.toString("utf8");
  }
}

export class IsolationCapacityError extends Error {
  constructor(roleId: string, capacity: number) {
    super(`cannot spawn isolated role "${roleId}": isolation chamber capacity of ${capacity} already reached`);
    this.name = "IsolationCapacityError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(roleId: string, timeoutMs: number) {
    super(`isolated role "${roleId}" timed out after ${timeoutMs}ms; sent abort and terminated the process`);
    this.name = "RpcTimeoutError";
  }
}

/** Thrown by a specific session handle's prompt()/abort() once its own close() has run (or its child process has exited) -- mirrors ../roles/session-manager.ts's RoleSessionDisposedError. */
export class RpcChamberSessionClosedError extends Error {
  constructor(roleId: string) {
    super(`isolated role session "${roleId}" is already closed`);
    this.name = "RpcChamberSessionClosedError";
  }
}

/** Thrown by RpcChamber's roleId-keyed prompt()/abort() when no isolated session is currently active for that roleId -- mirrors ../roles/session-manager.ts's RoleSessionNotFoundError. */
export class IsolatedRoleNotFoundError extends Error {
  constructor(roleId: string) {
    super(`no active isolated role session for roleId "${roleId}"`);
    this.name = "IsolatedRoleNotFoundError";
  }
}

export interface RpcPromptResult {
  readonly success: boolean;
  readonly error?: string;
}

/** A cancelable scheduled timeout -- see TimeoutScheduler. */
export interface TimeoutHandle {
  cancel(): void;
}

/** Schedules `callback` to run after `ms`. Default: real setTimeout/clearTimeout. Inject a fake in tests so timeout behavior is synchronous and deterministic (mirrors ../tools/mail/agently-mail.ts's injectable `sleep`). */
export type TimeoutScheduler = (callback: () => void, ms: number) => TimeoutHandle;

function defaultTimeoutScheduler(callback: () => void, ms: number): TimeoutHandle {
  const timer = setTimeout(callback, ms);
  return { cancel: (): void => clearTimeout(timer) };
}

/** One live isolated role instance -- exactly one child process, released by close(). Returned by RpcChamber.spawn(). */
export interface IsolatedRoleSession {
  readonly genome: RoleGenome;
  prompt(text: string): Promise<RpcPromptResult>;
  abort(): Promise<RpcPromptResult>;
  close(): Promise<void>;
  /** Diagnostics only -- the bounded stderr tail collected so far (see StderrTail). */
  readonly stderrTail: string;
}

export interface RpcChamberOptions {
  /** Max concurrently-running isolated roles. Default 1 -- design doc 4.2's first-release hard cap. */
  readonly capacity?: number;
  /** Builds each spawned genome's child process. Default: createPiRpcProcessSpawner(). Inject a fake in tests. */
  readonly spawner?: RpcProcessSpawner;
  /** How long prompt()/abort() wait for a matching response before timing out. Default 30_000ms. */
  readonly requestTimeoutMs?: number;
  /** Schedules each pending request's timeout. Default: real setTimeout. Inject a fake in tests. */
  readonly scheduleTimeout?: TimeoutScheduler;
  /** Id generator for outbound requests. Default: randomUUID(). Inject in tests for deterministic ids. */
  readonly nextRequestId?: () => string;
}

const DEFAULT_CAPACITY = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  readonly resolve: (result: RpcPromptResult) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: TimeoutHandle;
}

type OutboundMessage = { readonly type: "prompt"; readonly message: string } | { readonly type: "abort" };

/**
 * One spawned genome's live child process plus its request/response
 * bookkeeping. Not exported -- IsolatedRoleSession is the public shape
 * (mirrors ../roles/session-manager.ts's PiManagedRoleSession/ManagedRoleSession
 * split).
 */
class RpcChamberSession implements IsolatedRoleSession {
  readonly genome: RoleGenome;

  private readonly child: RpcChildProcess;
  private readonly requestTimeoutMs: number;
  private readonly scheduleTimeout: TimeoutScheduler;
  private readonly nextRequestId: () => string;
  private readonly onClosed: () => void;
  private readonly tail = new StderrTail();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly decoder: JsonlDecoder;
  private closed = false;

  constructor(
    genome: RoleGenome,
    child: RpcChildProcess,
    requestTimeoutMs: number,
    scheduleTimeout: TimeoutScheduler,
    nextRequestId: () => string,
    onClosed: () => void,
  ) {
    this.genome = genome;
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.scheduleTimeout = scheduleTimeout;
    this.nextRequestId = nextRequestId;
    this.onClosed = onClosed;
    this.decoder = new JsonlDecoder({
      onInvalidLine: (raw, error) => {
        // A malformed line from the child is a diagnostics concern, never a
        // crash -- see ./jsonl-decoder.ts's own documented error-handling
        // shape, which this mirrors by recording it into the same tail
        // buffer used for stderr.
        this.tail.push(Buffer.from(`[jsonl-decode-error] ${String(error)}: ${raw}\n`, "utf8"));
      },
    });

    this.child.stdout.on("data", (chunk) => {
      for (const record of this.decoder.push(chunk)) {
        this.handleLine(record);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.tail.push(chunk);
    });
    this.child.on("exit", () => {
      this.failAllPending(new RpcChamberSessionClosedError(this.genome.roleId));
      this.markClosed();
    });
    this.child.on("error", (error) => {
      this.failAllPending(error);
      this.markClosed();
    });
  }

  get stderrTail(): string {
    return this.tail.toString();
  }

  async prompt(text: string): Promise<RpcPromptResult> {
    return this.sendRequest({ type: "prompt", message: text });
  }

  async abort(): Promise<RpcPromptResult> {
    return this.sendRequest({ type: "abort" });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.failAllPending(new RpcChamberSessionClosedError(this.genome.roleId));
    this.markClosed();
    this.child.kill();
  }

  private markClosed(): void {
    if (!this.closed) {
      this.closed = true;
      this.onClosed();
    }
  }

  private sendRequest(message: OutboundMessage): Promise<RpcPromptResult> {
    if (this.closed) {
      return Promise.reject(new RpcChamberSessionClosedError(this.genome.roleId));
    }
    const id = this.nextRequestId();
    return new Promise<RpcPromptResult>((resolve, reject) => {
      const timeout = this.scheduleTimeout(() => {
        this.handleTimeout(id);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.write(id, message);
    });
  }

  private handleTimeout(id: string): void {
    const request = this.pending.get(id);
    if (!request) {
      return;
    }
    this.pending.delete(id);
    // "sends an abort message for that id, then kills the child process" --
    // fire-and-forget (the process just proved it may not be responsive),
    // never awaited.
    this.write(id, { type: "abort" });
    request.reject(new RpcTimeoutError(this.genome.roleId, this.requestTimeoutMs));
    void this.close();
  }

  private write(id: string, message: OutboundMessage): void {
    try {
      this.child.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
    } catch {
      // Best-effort -- if the child's stdin is already gone (e.g. the
      // process exited), there's nothing more to do here; the exit/error
      // handlers above already take care of rejecting any pending request.
    }
  }

  private handleLine(record: JsonlRecord): void {
    if (record["type"] !== "response") {
      // Real event traffic (message_update, tool_execution_*, ...) -- out
      // of scope for this task's minimal prompt/abort surface; see the
      // module doc comment.
      return;
    }
    const id = record["id"];
    if (typeof id !== "string") {
      return;
    }
    const request = this.pending.get(id);
    if (!request) {
      // Either a stray/duplicate response, or the id's own request already
      // timed out and was rejected -- either way, nothing to resolve.
      return;
    }
    this.pending.delete(id);
    request.timeout.cancel();
    const success = record["success"] === true;
    const error = typeof record["error"] === "string" ? record["error"] : undefined;
    request.resolve({ success, error });
  }

  private failAllPending(error: Error): void {
    for (const [id, request] of this.pending) {
      request.timeout.cancel();
      request.reject(error);
      this.pending.delete(id);
    }
  }
}

/**
 * Owns the swarm's isolation concurrency ceiling and spawns one
 * RpcChamberSession per isolated genome -- see the module doc comment for
 * the full contract. spawn() throws IsolationCapacityError (matching
 * /capacity/) rather than silently exceeding `capacity`, mirroring
 * ../ecology/population.ts's PopulationCapExceededError. spawn() also
 * refuses a structurally-invalid genome (delegates to
 * ../ecology/gene-bank.ts's validateGenome()) before it ever counts against
 * capacity or reaches a real process.
 */
export class RpcChamber {
  private readonly capacity: number;
  private readonly spawner: RpcProcessSpawner;
  private readonly requestTimeoutMs: number;
  private readonly scheduleTimeout: TimeoutScheduler;
  private readonly nextRequestId: () => string;
  private readonly sessions = new Set<RpcChamberSession>();
  private readonly byRoleId = new Map<string, RpcChamberSession>();
  /**
   * Count of spawn() calls that have reserved a capacity slot but haven't
   * finished awaiting their (now-async, since the model-routing lookup
   * added a real await point) spawner yet. Without this, two concurrent
   * spawn() calls could both pass the `sessions.size >= capacity` check
   * before either has added its session, exceeding `capacity`. Included in
   * every capacity check alongside `sessions.size`, released in spawn()'s
   * `finally` regardless of success or failure.
   */
  private pendingSpawns = 0;

  constructor(options: RpcChamberOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.spawner = options.spawner ?? createPiRpcProcessSpawner();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.scheduleTimeout = options.scheduleTimeout ?? defaultTimeoutScheduler;
    this.nextRequestId = options.nextRequestId ?? ((): string => randomUUID());
  }

  /** Currently-running isolated sessions. Never exceeds `capacity`. */
  get activeCount(): number {
    return this.sessions.size;
  }

  /** Spawns `genome` in its own child process. Throws InvalidGenomeError for a structurally-invalid genome, or IsolationCapacityError once `capacity` concurrently-running sessions already exist -- neither case spawns anything or consumes a capacity slot. */
  async spawn(genome: RoleGenome): Promise<IsolatedRoleSession> {
    validateGenome(genome);
    if (this.sessions.size + this.pendingSpawns >= this.capacity) {
      throw new IsolationCapacityError(genome.roleId, this.capacity);
    }

    this.pendingSpawns++;
    try {
      const child = await this.spawner(genome);
      const session: RpcChamberSession = new RpcChamberSession(
        genome,
        child,
        this.requestTimeoutMs,
        this.scheduleTimeout,
        this.nextRequestId,
        () => {
          this.sessions.delete(session);
          if (this.byRoleId.get(genome.roleId) === session) {
            this.byRoleId.delete(genome.roleId);
          }
        },
      );
      this.sessions.add(session);
      this.byRoleId.set(genome.roleId, session);
      return session;
    } finally {
      this.pendingSpawns--;
    }
  }

  /** Convenience roleId-keyed prompt(), mirroring ../roles/session-manager.ts's RoleSessionManager surface. Throws IsolatedRoleNotFoundError if no isolated session is currently active for roleId. */
  async prompt(roleId: string, text: string): Promise<RpcPromptResult> {
    return this.requireSession(roleId).prompt(text);
  }

  /** Convenience roleId-keyed abort(). Throws IsolatedRoleNotFoundError if no isolated session is currently active for roleId. */
  async abort(roleId: string): Promise<RpcPromptResult> {
    return this.requireSession(roleId).abort();
  }

  /** Closes every currently-running isolated session. */
  async close(): Promise<void> {
    await Promise.all([...this.sessions].map((session) => session.close()));
  }

  private requireSession(roleId: string): RpcChamberSession {
    const session = this.byRoleId.get(roleId);
    if (!session) {
      throw new IsolatedRoleNotFoundError(roleId);
    }
    return session;
  }
}
