/**
 * RoleSessionManager: owns one independent Pi Session per role, all resident
 * in this same Node process (never a separate OS process per role -- that's
 * only for "isolated" lifecycle roles, a future RpcChamber's job).
 *
 * Every role's session isolation and resource cleanup guarantee lives here:
 * - Each role id maps to at most one ManagedRoleSession, built from that
 *   role's own manifest (own system prompt, own tools, own session
 *   directory) via a real, independent Pi Session -- so message history
 *   never crosses between roles.
 * - sleep()/close() dispose the underlying PiSession, unsubscribe its event
 *   listener, and clear its flush timer, leaving zero dangling
 *   subscriptions/timers/listeners behind.
 *
 * Also owns the swarm-wide ecology gate the Queen (../ecology/queen.ts)
 * reacts through: setHibernationLevel()/HibernationLevel let a caller block
 * prompt()/steer()/followUp() once food state degrades to "reserve" (soft --
 * only non-essential roles are refused) or "hibernating" (hard -- every role
 * is refused, no exceptions). See assertMayPrompt() and SwarmHibernatingError
 * below. abort()/sleep()/close() are deliberately never gated, so cancelling
 * or sleeping a role always works regardless of hibernation level.
 */

import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager as PiPersistenceSessionManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { config as defaultConfig } from "../config.js";
import { loadRolePrompt } from "./manifests.js";
import { resolveRoleModel } from "./model-routing.js";
import { PiEventAdapter } from "./pi-event-adapter.js";
import type { RoleManifestRegistry } from "./registry.js";
import type {
  ManagedRoleSession,
  MappedPiUpdate,
  PiSession,
  PiSessionProvider,
  RoleManifest,
  RoleModelClassRouting,
  RoleSessionManager,
  RoleSessionUpdate,
} from "./types.js";

export class RoleSessionNotFoundError extends Error {
  constructor(roleId: string) {
    super(`no active or registered role session for roleId "${roleId}"`);
    this.name = "RoleSessionNotFoundError";
  }
}

/** Thrown when a caller holds a ManagedRoleSession reference obtained before sleep()/close() and keeps calling it afterward, instead of going through the manager (which always hands back a fresh session). */
export class RoleSessionDisposedError extends Error {
  constructor(roleId: string) {
    super(`role session "${roleId}" has already been disposed`);
    this.name = "RoleSessionDisposedError";
  }
}

/**
 * Swarm-wide ecology gate, driven by the Queen's food-state reaction
 * (../ecology/queen.ts), never by this manager itself:
 * - "none": normal operation, nothing is gated.
 * - "soft" (food state "reserve"): ordinary Pi prompts to non-essential
 *   workers are refused; a role the injected `isVoiceEssential` predicate
 *   accepts still runs normally.
 * - "hard" (food state "hibernating"): the swarm stops thinking entirely --
 *   every role is refused, `isVoiceEssential` is not even consulted, since
 *   no Pi prompt of any kind may run, not even a queued one.
 */
export type HibernationLevel = "none" | "soft" | "hard";

/** Decides whether `roleId` is exempt from a "soft" hibernation's non-essential-worker block. Never consulted under "hard" hibernation (see HibernationLevel's doc comment). Default (when none is injected): no role is exempt. */
export type VoiceEssentialPredicate = (roleId: string) => boolean;

/** Thrown by prompt()/steer()/followUp() when the swarm's current HibernationLevel refuses the call -- see assertMayPrompt() for exactly when. Deliberately never thrown by abort()/sleep()/close(), which stay available regardless of hibernation level (cancel-related interaction must always work). */
export class SwarmHibernatingError extends Error {
  constructor(roleId: string, level: HibernationLevel) {
    super(
      level === "hard"
        ? `role "${roleId}" cannot run a Pi prompt: the swarm is hard-hibernating (usage exhausted) and no Pi prompt of any kind may run`
        : `role "${roleId}" cannot run a Pi prompt: the swarm is soft-hibernating and this role is not voice-essential`,
    );
    this.name = "SwarmHibernatingError";
  }
}

const DEFAULT_FLUSH_INTERVAL_MS = 50;

/**
 * A live role instance: one PiSession, one PiEventAdapter aggregating its
 * message_update deltas, one flush timer, and any consumer subscriptions --
 * all released together by dispose().
 */
class PiManagedRoleSession implements ManagedRoleSession {
  readonly manifest: RoleManifest;
  readonly roleId: string;

  private readonly piSession: PiSession;
  private readonly adapter: PiEventAdapter;
  private readonly disposers = new Set<() => void>();
  private readonly listeners = new Set<(update: RoleSessionUpdate) => void>();
  private _currentTaskId: string | undefined;
  private disposed = false;

  constructor(manifest: RoleManifest, piSession: PiSession, flushIntervalMs: number) {
    this.manifest = manifest;
    this.roleId = manifest.id;
    this.piSession = piSession;
    this.adapter = new PiEventAdapter({ flushIntervalMs });

    const unsubscribe = piSession.subscribe((event) => {
      const mapped = this.adapter.accept(event);
      if (mapped) {
        this.broadcast(mapped);
      }
    });
    this.trackDisposer(unsubscribe);

    const timer = setInterval(() => {
      const mapped = this.adapter.flush();
      if (mapped) {
        this.broadcast(mapped);
      }
    }, flushIntervalMs);
    this.trackDisposer(() => clearInterval(timer));
  }

  get currentTaskId(): string | undefined {
    return this._currentTaskId;
  }

  get activeSubscriptionCount(): number {
    return this.disposers.size;
  }

  get messages(): readonly unknown[] {
    return this.piSession.messages;
  }

  async prompt(taskId: string, text: string): Promise<void> {
    this.assertNotDisposed();
    this._currentTaskId = taskId;
    await this.piSession.prompt(text);
  }

  async steer(taskId: string, text: string): Promise<void> {
    this.assertNotDisposed();
    this._currentTaskId = taskId;
    await this.piSession.steer(text);
  }

  async followUp(taskId: string, text: string): Promise<void> {
    this.assertNotDisposed();
    this._currentTaskId = taskId;
    await this.piSession.followUp(text);
  }

  async abort(_taskId: string): Promise<void> {
    this.assertNotDisposed();
    await this.piSession.abort();
  }

  subscribe(listener: (update: RoleSessionUpdate) => void): () => void {
    this.assertNotDisposed();
    this.listeners.add(listener);
    return this.trackDisposer(() => {
      this.listeners.delete(listener);
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposer of [...this.disposers]) {
      disposer();
    }
    this.disposers.clear();
    this.listeners.clear();
    this.piSession.dispose();
  }

  private broadcast(mapped: MappedPiUpdate): void {
    const update: RoleSessionUpdate = { ...mapped, roleId: this.roleId, taskId: this._currentTaskId };
    for (const listener of this.listeners) {
      listener(update);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new RoleSessionDisposedError(this.roleId);
    }
  }

  /** Wraps `fn` so it self-removes from `disposers` before running, making every disposer safe to call at most once and `activeSubscriptionCount` an honest live count. */
  private trackDisposer(fn: () => void): () => void {
    const wrapped = (): void => {
      if (this.disposers.delete(wrapped)) {
        fn();
      }
    };
    this.disposers.add(wrapped);
    return wrapped;
  }
}

export interface RoleSessionManagerOptions {
  /** Resolves a bare roleId (from prompt()/steer()/followUp()/abort()) to a manifest when no session is active for it yet. */
  readonly registry: RoleManifestRegistry;
  /** Builds the underlying Pi Session for a role. Inject a fake in tests; use createDefaultPiSessionProvider() (or an equivalent) in production. */
  readonly provider: PiSessionProvider;
  /** How often each role's PiEventAdapter is flushed. Default: 50ms, per the design doc's aggregation window. */
  readonly flushIntervalMs?: number;
  /** Consulted by prompt()/steer()/followUp() while HibernationLevel is "soft" (never "hard"). Default: no role is exempt, so every role is an ordinary/ "non-essential" worker unless a caller explicitly injects otherwise. */
  readonly isVoiceEssential?: VoiceEssentialPredicate;
}

/**
 * Production-shaped RoleSessionManager: generic over `provider`, so the
 * exact same class handles both real Pi-backed roles (via
 * createDefaultPiSessionProvider()) and fully in-memory test doubles --
 * only the injected PiSessionProvider differs.
 */
export class PiRoleSessionManager implements RoleSessionManager {
  private readonly registry: RoleManifestRegistry;
  private readonly provider: PiSessionProvider;
  private readonly flushIntervalMs: number;
  private readonly isVoiceEssential: VoiceEssentialPredicate;
  private hibernationLevel: HibernationLevel = "none";

  /** Fully-resolved, currently-active sessions. */
  private readonly sessions = new Map<string, PiManagedRoleSession>();
  /** In-flight ensure() calls, keyed by roleId, so concurrent ensure()s for the same never-before-seen role share one PiSession instead of each building (and one leaking) their own. */
  private readonly pending = new Map<string, Promise<PiManagedRoleSession>>();

  constructor(options: RoleSessionManagerOptions) {
    this.registry = options.registry;
    this.provider = options.provider;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.isVoiceEssential = options.isVoiceEssential ?? ((): boolean => false);
  }

  /** Not part of the RoleSessionManager contract (mirrors debugMessages()/debugActiveSubscriptions()'s "extra, manager-only" status): sets the swarm-wide ecology gate consulted by prompt()/steer()/followUp() -- see HibernationLevel's doc comment for exactly what "soft"/"hard" each block. Never affects abort()/sleep()/close(), which stay available at any level. */
  setHibernationLevel(level: HibernationLevel): void {
    this.hibernationLevel = level;
  }

  /** Not part of the RoleSessionManager contract: the swarm-wide ecology gate most recently set via setHibernationLevel(). Default "none". */
  get currentHibernationLevel(): HibernationLevel {
    return this.hibernationLevel;
  }

  async ensure(manifest: RoleManifest): Promise<ManagedRoleSession> {
    return this.ensureInternal(manifest);
  }

  async prompt(roleId: string, taskId: string, text: string): Promise<void> {
    this.assertMayPrompt(roleId);
    const session = await this.resolveOrProvision(roleId);
    await session.prompt(taskId, text);
  }

  async steer(roleId: string, taskId: string, text: string): Promise<void> {
    this.assertMayPrompt(roleId);
    const session = await this.requireActive(roleId);
    await session.steer(taskId, text);
  }

  async followUp(roleId: string, taskId: string, text: string): Promise<void> {
    this.assertMayPrompt(roleId);
    const session = await this.requireActive(roleId);
    await session.followUp(taskId, text);
  }

  async abort(roleId: string, taskId: string): Promise<void> {
    const session = await this.requireActive(roleId);
    await session.abort(taskId);
  }

  async sleep(roleId: string): Promise<void> {
    const pending = this.pending.get(roleId);
    const session = pending ? await pending : this.sessions.get(roleId);
    this.sessions.delete(roleId);
    this.pending.delete(roleId);
    session?.dispose();
  }

  async close(): Promise<void> {
    const active = [...this.sessions.values()];
    this.sessions.clear();
    const inFlight = [...this.pending.values()];
    this.pending.clear();

    const settled = await Promise.all(inFlight.map((creation) => creation.catch(() => undefined)));
    for (const session of [...active, ...settled]) {
      session?.dispose();
    }
  }

  /** Debug/testing helper (not part of the RoleSessionManager contract): the underlying Pi Session's message history for a role, or `[]` if it has none/is not active. */
  debugMessages(roleId: string): readonly unknown[] {
    return this.sessions.get(roleId)?.messages ?? [];
  }

  /** Debug/testing helper: how many release-worthy resources (Pi event subscription, flush timer, external subscribe() listeners) the role's session currently holds. 0 once the role is asleep/never started. */
  debugActiveSubscriptions(roleId: string): number {
    return this.sessions.get(roleId)?.activeSubscriptionCount ?? 0;
  }

  private async ensureInternal(manifest: RoleManifest): Promise<PiManagedRoleSession> {
    const active = this.sessions.get(manifest.id);
    if (active) {
      return active;
    }

    const inFlight = this.pending.get(manifest.id);
    if (inFlight) {
      return inFlight;
    }

    this.registry.register(manifest);

    const creation = this.buildSession(manifest)
      .then((session) => {
        this.sessions.set(manifest.id, session);
        this.pending.delete(manifest.id);
        return session;
      })
      .catch((error: unknown) => {
        this.pending.delete(manifest.id);
        throw error;
      });
    this.pending.set(manifest.id, creation);
    return creation;
  }

  private async buildSession(manifest: RoleManifest): Promise<PiManagedRoleSession> {
    const piSession = await this.provider(manifest);
    return new PiManagedRoleSession(manifest, piSession, this.flushIntervalMs);
  }

  /**
   * Consulted by prompt()/steer()/followUp() before they touch a Pi
   * Session -- never by abort()/sleep()/close(), which must stay available
   * regardless of hibernation level so an in-flight task can always be
   * cancelled and a role can always be put to sleep. Deliberately
   * synchronous and side-effect-free (throws or returns).
   */
  private assertMayPrompt(roleId: string): void {
    if (this.hibernationLevel === "none") {
      return;
    }
    if (this.hibernationLevel === "hard") {
      throw new SwarmHibernatingError(roleId, "hard");
    }
    if (!this.isVoiceEssential(roleId)) {
      throw new SwarmHibernatingError(roleId, "soft");
    }
  }

  /** Resolves an active/in-flight session for roleId, provisioning a fresh one from the registry if none exists yet. Used by prompt(), which is allowed to start a role on first use. */
  private async resolveOrProvision(roleId: string): Promise<PiManagedRoleSession> {
    const active = this.sessions.get(roleId);
    if (active) {
      return active;
    }
    const inFlight = this.pending.get(roleId);
    if (inFlight) {
      return inFlight;
    }
    const manifest = this.registry.get(roleId);
    if (!manifest) {
      throw new RoleSessionNotFoundError(roleId);
    }
    return this.ensureInternal(manifest);
  }

  /** Resolves an active/in-flight session for roleId, throwing if the role was never ensure()'d/prompt()'d. Used by steer()/followUp()/abort(), which act on an already-running role rather than starting a new one. */
  private async requireActive(roleId: string): Promise<PiManagedRoleSession> {
    const active = this.sessions.get(roleId);
    if (active) {
      return active;
    }
    const inFlight = this.pending.get(roleId);
    if (inFlight) {
      return inFlight;
    }
    throw new RoleSessionNotFoundError(roleId);
  }
}

export interface DefaultPiSessionProviderOptions {
  /** Working directory for resource discovery. Default: process.cwd() */
  readonly cwd?: string;
  /** Global pi config directory. Default: getAgentDir() (~/.pi/agent) */
  readonly agentDir?: string;
  /** Base directory under which each role gets its own persisted session subdirectory. Default: <agentDir>/roles */
  readonly sessionRootDir?: string;
  /** Which concrete provider/model each RoleManifest.modelClass tier resolves to. Default: config.modelClassRouting (../config.ts), overridable via env vars. */
  readonly modelRouting?: RoleModelClassRouting;
  /** Shared ModelRuntime every role's session (and modelClass resolution) is built against. Inject a fake (satisfying ../roles/model-routing.ts's ModelCatalog) in tests; default: one real `ModelRuntime.create({ agentDir })`, built lazily on first use and reused for every subsequent role so the auth/model catalog is only ever loaded once per process. */
  readonly modelRuntime?: ModelRuntime;
}

/**
 * Production PiSessionProvider: builds a real Pi Session via the verified
 * `createAgentSession()` SDK entry point. Each role gets its own system
 * prompt (its manifest's promptPath, read from disk), its own tool
 * allowlist, its own persisted session directory, and -- per its manifest's
 * modelClass -- its own concrete model (see ./model-routing.ts), so two
 * roles never share Pi-side state even though they share this Node
 * process, and a "fast"-tier role no longer silently rides whatever model
 * a "deep"-tier role happens to also be using.
 *
 * PiRoleSessionManager's own unit tests inject a fake PiSessionProvider and
 * never exercise this function directly; see session-provider.test.ts for
 * this function's wiring coverage (mocking @earendil-works/pi-coding-agent
 * entirely) and model-routing.test.ts for resolveRoleModel()'s own coverage
 * against a fake ModelCatalog.
 */
export function createDefaultPiSessionProvider(
  options: DefaultPiSessionProviderOptions = {},
): PiSessionProvider {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  const sessionRootDir = options.sessionRootDir ?? path.join(agentDir, "roles");
  const modelRouting = options.modelRouting ?? defaultConfig.modelClassRouting;

  let modelRuntimePromise: Promise<ModelRuntime> | undefined;
  const getModelRuntime = (): Promise<ModelRuntime> => {
    modelRuntimePromise ??= options.modelRuntime
      ? Promise.resolve(options.modelRuntime)
      : ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
    return modelRuntimePromise;
  };

  return async (manifest: RoleManifest): Promise<PiSession> => {
    const systemPrompt = loadRolePrompt(manifest.promptPath);

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      systemPrompt,
    });
    await resourceLoader.reload();

    const sessionManager = PiPersistenceSessionManager.create(cwd, path.join(sessionRootDir, manifest.id));

    const modelRuntime = await getModelRuntime();
    const model = await resolveRoleModel(modelRuntime, manifest.id, manifest.modelClass, modelRouting);

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      resourceLoader,
      sessionManager,
      tools: [...manifest.tools],
      thinkingLevel: manifest.thinkingLevel,
    });

    return session;
  };
}
