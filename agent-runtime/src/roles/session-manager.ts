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
 */

import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager as PiPersistenceSessionManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { loadRolePrompt } from "./manifests.js";
import { PiEventAdapter } from "./pi-event-adapter.js";
import type { RoleManifestRegistry } from "./registry.js";
import type {
  ManagedRoleSession,
  MappedPiUpdate,
  PiSession,
  PiSessionProvider,
  RoleManifest,
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

  /** Fully-resolved, currently-active sessions. */
  private readonly sessions = new Map<string, PiManagedRoleSession>();
  /** In-flight ensure() calls, keyed by roleId, so concurrent ensure()s for the same never-before-seen role share one PiSession instead of each building (and one leaking) their own. */
  private readonly pending = new Map<string, Promise<PiManagedRoleSession>>();

  constructor(options: RoleSessionManagerOptions) {
    this.registry = options.registry;
    this.provider = options.provider;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  async ensure(manifest: RoleManifest): Promise<ManagedRoleSession> {
    return this.ensureInternal(manifest);
  }

  async prompt(roleId: string, taskId: string, text: string): Promise<void> {
    const session = await this.resolveOrProvision(roleId);
    await session.prompt(taskId, text);
  }

  async steer(roleId: string, taskId: string, text: string): Promise<void> {
    const session = await this.requireActive(roleId);
    await session.steer(taskId, text);
  }

  async followUp(roleId: string, taskId: string, text: string): Promise<void> {
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
}

/**
 * Production PiSessionProvider: builds a real Pi Session via the verified
 * `createAgentSession()` SDK entry point. Each role gets its own system
 * prompt (its manifest's promptPath, read from disk), its own tool
 * allowlist, and its own persisted session directory, so two roles never
 * share Pi-side state even though they share this Node process.
 *
 * Not exercised by this task's unit tests (which inject a fake provider
 * instead) -- model selection in particular is left to SDK defaults here
 * since RoleManifest.modelClass -> concrete Model routing is a later
 * task's concern.
 */
export function createDefaultPiSessionProvider(
  options: DefaultPiSessionProviderOptions = {},
): PiSessionProvider {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  const sessionRootDir = options.sessionRootDir ?? path.join(agentDir, "roles");

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

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      sessionManager,
      tools: [...manifest.tools],
      thinkingLevel: manifest.thinkingLevel,
    });

    return session;
  };
}
