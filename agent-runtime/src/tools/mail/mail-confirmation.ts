/**
 * Confirmation gate for mail actions that cannot be taken back (send, reply,
 * forward, trash).
 *
 * The agently-mail skill's rule is that a write is shown to the user first and
 * only performed after the user, in a LATER turn, says yes -- the assistant
 * must never confirm for itself in the same turn. CapabilityGateway alone
 * cannot give that: an ordinary single send is ALLOW_LOGGED (autonomous), and
 * mail bodies are untrusted text that may try to talk the model into sending
 * something. So the tools are two-step in code:
 *
 *   1. The first call only PREPARES the action and returns a confirmation id.
 *   2. The same call repeated with that id runs it -- but only if the exact
 *      same arguments were prepared (a different recipient or body is a new
 *      action), the id has not expired, and the USER has spoken since it was
 *      prepared. A model that prepares and confirms within one turn is refused.
 *
 * "The user has spoken" is counted by noteUserUtterance(), which the task
 * executor calls for every final transcript. The role that prepared the
 * action is remembered so the executor can route the user's "好，发吧" back to
 * it rather than to the general worker (which has no mail tools).
 */

import { randomUUID } from "node:crypto";

export interface PendingMailAction {
  readonly id: string;
  readonly fingerprint: string;
  readonly summary: string;
  readonly roleId: string;
  readonly createdAtMs: number;
  /** utteranceCount when prepared; the user must have spoken since. */
  readonly utterancesAtPrepare: number;
}

export type ConsumeOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface MailConfirmationGateOptions {
  readonly now?: () => number;
  /** How long a prepared action stays confirmable. Default 5 minutes (the CLI's own token lifetime). */
  readonly ttlMs?: number;
  /** Bound on remembered pending actions; the oldest is dropped first. */
  readonly capacity?: number;
}

const REFUSAL = /^(算了|不用了|不要|别发|不发|先不|取消|不行|no\b|don'?t\b|cancel|never ?mind|stop\b)/i;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CAPACITY = 16;

export class MailConfirmationGate {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly pending = new Map<string, PendingMailAction>();
  private utteranceCount = 0;

  constructor(options: MailConfirmationGateOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
  }

  /**
   * Called for every final user transcript. A plain refusal ("算了", "不要",
   * "cancel") withdraws whatever was waiting for a yes.
   */
  noteUserUtterance(transcript?: string): void {
    this.utteranceCount += 1;
    if (transcript !== undefined && REFUSAL.test(transcript.trim())) {
      this.pending.clear();
    }
  }

  /** Registers an action awaiting the user's yes; replaces an earlier identical one. */
  prepare(fingerprint: string, summary: string, roleId: string): PendingMailAction {
    this.dropExpired();
    for (const [id, existing] of this.pending) {
      if (existing.fingerprint === fingerprint) {
        this.pending.delete(id);
      }
    }
    while (this.pending.size >= this.capacity) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const action: PendingMailAction = {
      id: `mc_${randomUUID().slice(0, 8)}`,
      fingerprint,
      summary,
      roleId,
      createdAtMs: this.now(),
      utterancesAtPrepare: this.utteranceCount,
    };
    this.pending.set(action.id, action);
    return action;
  }

  /** Validates and, when valid, consumes `id` (a confirmation is single-use). */
  consume(id: string, fingerprint: string): ConsumeOutcome {
    this.dropExpired();
    const action = this.pending.get(id);
    if (!action) {
      return { ok: false, reason: "that confirmation id is unknown or expired -- prepare the action again" };
    }
    if (action.fingerprint !== fingerprint) {
      return { ok: false, reason: "the arguments differ from what was prepared -- that is a different action, prepare it again" };
    }
    if (this.utteranceCount <= action.utterancesAtPrepare) {
      return { ok: false, reason: "the user has not answered yet -- read the summary to them, then wait for their yes" };
    }
    this.pending.delete(id);
    return { ok: true };
  }

  /** Forgets everything pending (e.g. the user said never mind). */
  clear(): void {
    this.pending.clear();
  }

  /** The role that most recently prepared a still-pending action, if any. */
  pendingRoleId(): string | undefined {
    this.dropExpired();
    let latest: PendingMailAction | undefined;
    for (const action of this.pending.values()) {
      if (!latest || action.createdAtMs >= latest.createdAtMs) latest = action;
    }
    return latest?.roleId;
  }

  private dropExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, action] of this.pending) {
      if (action.createdAtMs < cutoff) this.pending.delete(id);
    }
  }
}
