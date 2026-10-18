/**
 * Scribe: the session topic-segmentation expert (话题捕捉专家). Its job is
 * not to execute anything -- it watches the conversation, detects when the
 * topic shifts, and keeps a compact topic ledger.
 *
 * How it works (token-frugal, mirrors coding-agent context compaction):
 * - Every user/agent utterance is appended to the TranscriptBoard.
 * - A periodic sweep (default 30s) checks the UNARCHIVED increment. Only
 *   when the increment is big enough is the LLM invoked.
 * - The LLM sees ONLY: the previous topic ledger (the compressed summary of
 *   everything archived so far) + the new increment. It outputs the updated
 *   ledger: stable topics carry forward, a genuinely new topic is added,
 *   and when the conversation has moved on, old topics are marked "closed".
 * - After a successful sweep the increment is archived. The full session
 *   text is never re-fed.
 *
 * Topic-change signals and material are published to the InfoHub so
 * downstream roles (e.g. TaskExecutor) can re-anchor their context when the
 * conversation switches subjects.
 */

import type { PiRoleSessionManager } from "../roles/session-manager.js";
import type { InfoHub, TopicItem } from "../hub/info-hub.js";
import { TranscriptBoard } from "./transcript-board.js";

export interface ScribeOptions {
  readonly board: TranscriptBoard;
  readonly sessionManager: PiRoleSessionManager;
  readonly hub: InfoHub;
  readonly roleId?: string;
  readonly sweepIntervalMs?: number;
  readonly minActiveChars?: number;
  readonly minActiveEntries?: number;
  readonly now?: () => Date;
  readonly onTopicsUpdated?: (topics: readonly TopicItem[], reason: string) => void;
  readonly onError?: (error: unknown) => void;
  readonly isEnabled?: () => boolean;
}

const DEFAULT_ROLE_ID = "scribe";
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_MIN_ACTIVE_CHARS = 200;
const DEFAULT_MIN_ACTIVE_ENTRIES = 3;

const SYSTEM_PROMPT = `You are Scribe, the conversation topic-segmentation expert. You watch a voice-agent session and maintain a TOPIC LEDGER.

A topic is a coherent conversational subject -- it may be a task ("查上海天气"), a chat thread ("聊聊最近的电影"), or any sustained subject. Each topic has:
  - "id": stable English slug, e.g. "weather-shanghai" (identity, never changes)
  - "phrase": the topic's key phrase in the user's language, e.g. "天气查询" (<= 10 chars)
  - "summary": ONE sentence summarizing this topic's content so far (<= 40 chars)
  - "status": "active" (currently being discussed) | "closed" (conversation moved on)

CRITICAL RULES:
- The PREVIOUS TOPIC LEDGER is the session's history. Carry forward every topic, updating summaries as the conversation develops. NEVER drop or rename topics.
- A topic becomes "closed" ONLY when the conversation clearly moved to a different subject and the old one is no longer being discussed.
- At most ONE topic is "active" -- the one currently being discussed.
- New conversation APPENDS to the ledger; it does not replace it.
- Output ONLY a JSON array, no prose, no markdown:
  [{"id":"weather-shanghai","phrase":"天气查询","summary":"用户查询上海和北京的天气与空气质量","status":"active"}]`;

export class Scribe {
  private readonly board: TranscriptBoard;
  private readonly sessionManager: PiRoleSessionManager;
  private readonly hub: InfoHub;
  private readonly roleId: string;
  private readonly sweepIntervalMs: number;
  private readonly minActiveChars: number;
  private readonly minActiveEntries: number;
  private readonly now: () => Date;
  private readonly onTopicsUpdated: (topics: readonly TopicItem[], reason: string) => void;
  private readonly onError: (error: unknown) => void;
  private readonly isEnabled: () => boolean;

  private topicList: readonly TopicItem[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;

  constructor(options: ScribeOptions) {
    this.board = options.board;
    this.sessionManager = options.sessionManager;
    this.hub = options.hub;
    this.roleId = options.roleId ?? DEFAULT_ROLE_ID;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.minActiveChars = options.minActiveChars ?? DEFAULT_MIN_ACTIVE_CHARS;
    this.minActiveEntries = options.minActiveEntries ?? DEFAULT_MIN_ACTIVE_ENTRIES;
    this.now = options.now ?? (() => new Date());
    this.onTopicsUpdated = options.onTopicsUpdated ?? (() => {});
    this.onError = options.onError ?? (() => {});
    this.isEnabled = options.isEnabled ?? (() => true);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => this.onError(error));
    }, this.sweepIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get topics(): readonly TopicItem[] {
    return this.topicList;
  }

  /**
   * One sweep. When `force` is true (a completed turn poked us), the
   * threshold check is bypassed: any unarchived content is worth
   * segmenting, so a single short exchange still updates the ledger
   * promptly instead of waiting for the 30s timer to accumulate enough.
   */
  async sweep(force = false): Promise<void> {
    if (this.sweeping) return;
    if (!this.isEnabled()) return;

    const active = this.board.activeEntries();
    if (active.length === 0) return;
    if (!force && active.length < this.minActiveEntries && this.board.activeCharCount() < this.minActiveChars) {
      return;
    }

    this.sweeping = true;
    try {
      const result = await this.segment(active);
      const last = active[active.length - 1];
      if (last) {
        this.board.archiveUpTo(last.seq);
      }
      if (result !== null) {
        this.topicList = result;
        const changed = this.hub.setTopics(result, this.now);
        this.onTopicsUpdated(result, changed ? `topic change: -> ${changed.current.phrase}` : `sweep: ${active.length} entries`);
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async segment(active: readonly { speaker: "user" | "agent"; text: string }[]): Promise<readonly TopicItem[] | null> {
    const previous = this.topicList.length === 0 ? "(none)" : JSON.stringify(this.topicList);
    const increment = active.map((e) => `${e.speaker === "user" ? "USER" : "AGENT"}: ${e.text}`).join("\n");
    const prompt = `${SYSTEM_PROMPT}

PREVIOUS TOPIC LEDGER:
${previous}

NEW CONVERSATION (unsummarized):
${increment}

OUTPUT: the updated topic ledger as a JSON array.`;

    const { SCRIBE_ROLE_MANIFEST } = await import("../roles/manifests.js");
    const session = await this.sessionManager.ensure(SCRIBE_ROLE_MANIFEST);
    const updates: string[] = [];
    const unsubscribe = session.subscribe((update) => {
      if (update.type === "task.progress" && typeof update.payload.text === "string") {
        updates.push(update.payload.text);
      }
    });

    try {
      await this.sessionManager.prompt(this.roleId, "scribe-sweep", prompt);
      await this.waitForJson(updates);
    } finally {
      unsubscribe();
    }

    const joined = updates.join("");
    const parsed = this.parseTopicList(joined);
    if (parsed === null) {
      console.log(`[scribe] sweep produced no parseable ledger: "${joined.slice(0, 120)}"`);
      return null;
    }
    if (parsed.length === 0 && this.topicList.length > 0) {
      console.log("[scribe] sweep returned empty ledger; preserving previous");
      return null;
    }
    return parsed;
  }

  private waitForJson(updates: string[]): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (updates.some((u) => u.includes("[") && u.includes("]"))) {
          resolve();
        } else {
          setTimeout(check, 250);
        }
      };
      setTimeout(check, 250);
    });
  }

  private parseTopicList(text: string): readonly TopicItem[] | null {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    try {
      const raw = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (!Array.isArray(raw)) return null;
      const items: TopicItem[] = [];
      for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.phrase !== "string") continue;
        items.push({
          id: record.id,
          phrase: record.phrase,
          summary: typeof record.summary === "string" ? record.summary : "",
          status: record.status === "closed" ? "closed" : "active",
          updatedAt: this.now().toISOString(),
        });
      }
      return items.length === 0 ? null : items;
    } catch {
      return null;
    }
  }
}
