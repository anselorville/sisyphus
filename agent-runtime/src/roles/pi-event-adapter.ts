/**
 * Maps real Pi SDK events (`AgentSessionEvent`, as emitted by
 * `AgentSession.subscribe()`) onto this project's own RealtimeEvent
 * vocabulary, and aggregates `message_update` text deltas so the rest of
 * the sidecar never sees a raw per-token stream.
 *
 * This is a hard architecture rule (see the plan's Global Constraints and
 * .proj-init/04-autonomous-swarm-voice-agent-software-design.md: "Pi
 * streaming token 只在 sidecar 聚合，不能逐 token 跨进程或直接进入 TTS"),
 * not a style preference: `accept()` structurally cannot hand back a raw
 * text_delta, because it never returns one -- deltas only ever leave this
 * class through flush(), already merged into a single string.
 *
 * PiEventAdapter itself owns no timer: accept()/flush() are both plain
 * synchronous calls. The "merge every flushIntervalMs" behavior is realized
 * by whoever owns this adapter (ManagedRoleSession) polling flush() on its
 * own disposable interval -- that keeps every timer's lifetime tied to a
 * single, already-disposal-tracked owner instead of being duplicated here.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { MappedPiUpdate } from "./types.js";

export interface PiEventAdapterOptions {
  /** How often the owner intends to call flush(). Not enforced by this class (it owns no timer) -- stored so the owner has one shared source of truth for the interval. */
  readonly flushIntervalMs: number;
}

// Sentence boundaries used to split streaming text into speakable chunks:
// Chinese/Japanese sentence-final punctuation, Western terminal punctuation
// (but NOT the "1." of a numbered list -- negative lookbehind excludes a
// dot preceded by a digit), and newline breaks (markdown paragraphs from
// the LLM are sentence boundaries too -- a newline usually ends a coherent
// utterance).
const SENTENCE_END_RE = /[。！？!?；;…]+|(?<!\d)[.!?]+(?:\s|$)|(?:\n\s*\n)/;

// Secondary breaks used to split an over-long sentence (one that would
// exceed the voice herald's speakable-length cap and get dropped entirely):
// commas, semicolons, and the Chinese enumeration comma (顿号). Splitting
// here keeps every chunk speakable instead of losing a whole paragraph to
// the length filter.
const CLAUSE_BREAK_RE = /[，,；;、]/g;

// Soft cap: keep each emitted chunk comfortably under VoiceHerald's
// MAX_SPEAKABLE_LENGTH (160) so the herald never rejects it wholesale.
const MAX_CHUNK_LENGTH = 150;

// Normalizes a chunk for speech: collapses internal newlines to a comma so
// a multi-line list ("1. 巴西\n2. 阿根廷\n...") never trips VoiceHerald's
// 3-newline reject rule and reads naturally when spoken.
/**
 * Turns an LLM text chunk into something a TTS engine can read aloud. Models
 * answer in Markdown by habit; spoken, `**bold**` becomes "star star bold" and
 * a bullet becomes a stray symbol. So emphasis, headings, list markers, links
 * and code are reduced to their words, and line breaks become spoken pauses.
 * Chunks arrive sentence by sentence, so a lone opening `**` whose closer is
 * in the next chunk is stripped too.
 */
export function normalizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*+•][ \t]+/gm, "")
    .replace(/^[ \t]*\d+[.)、][ \t]+/gm, "")
    .replace(/\*+/g, "")
    .replace(/\n+/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export class PiEventAdapter {
  readonly flushIntervalMs: number;
  private pendingText = "";

  constructor(options: PiEventAdapterOptions) {
    if (!Number.isFinite(options.flushIntervalMs) || options.flushIntervalMs <= 0) {
      throw new RangeError("flushIntervalMs must be a positive, finite number of milliseconds");
    }
    this.flushIntervalMs = options.flushIntervalMs;
  }

  /**
   * Feeds one raw Pi SDK event into the adapter.
   *
   * `message_update` text deltas are buffered and always return `undefined`
   * -- flush() is the only path that turns them into a broadcastable
   * update. Every other mapped event kind is discrete (not a fragment of a
   * larger stream), so it is mapped and returned immediately.
   */
  accept(event: AgentSessionEvent): MappedPiUpdate | undefined {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.pendingText += event.assistantMessageEvent.delta;
        }
        // Every other AssistantMessageEvent sub-kind (thinking deltas,
        // tool-call deltas, start/end markers, ...) is streaming detail
        // that must never be broadcast either; ignored on purpose.
        return undefined;

      case "agent_start":
        // Marks this role's Pi Session beginning work on the prompt it was
        // just given.
        return { type: "task.assigned", payload: {} };

      case "tool_execution_start":
        return {
          type: "tool.started",
          payload: { tool_call_id: event.toolCallId, tool_name: event.toolName, args: event.args },
        };

      case "tool_execution_end":
        return {
          type: event.isError ? "tool.failed" : "tool.completed",
          payload: { tool_call_id: event.toolCallId, tool_name: event.toolName, result: event.result },
        };

      case "turn_end":
        // A turn boundary: the agent produced a message and/or ran tools
        // and is about to decide whether another turn is needed. Surfaced
        // as a coalescible progress marker, not a terminal task state.
        return { type: "task.progress", payload: { turn_ended: true } };

      case "agent_end":
        // This role's Pi Session finished the run it was given. Whether
        // that run succeeded or failed at the task level is business logic
        // this adapter does not have enough information to decide (no
        // error flag is carried on agent_end) -- left for a future
        // task/role-bridge to refine by inspecting message content.
        return { type: "task.completed", payload: { will_retry: event.willRetry } };

      case "queue_update":
        // Pi's own steer/followUp queue depth changed; useful as a UI
        // status marker ("N messages queued"), distinct from this
        // project's task.steer/task.follow_up events (which represent the
        // inbound instruction itself, not a queue-depth snapshot).
        return {
          type: "task.progress",
          payload: { steering: [...event.steering], follow_up: [...event.followUp] },
        };

      default:
        // turn_start, message_start/message_end, tool_execution_update,
        // compaction_*, entry_appended, session_info_changed,
        // thinking_level_changed, auto_retry_*, summarization_retry_*,
        // bash_execution_update, agent_settled: internal detail this
        // sidecar does not need to broadcast.
        return undefined;
    }
  }

  /**
   * Drains buffered text_delta text into aggregated, sentence-complete
   * `task.progress` updates, or returns `undefined` if nothing is pending.
   *
   * Sentence-aware (unlike a plain time-slice flush): only complete
   * sentences are emitted -- a trailing half-sentence is kept buffered so
   * TTS never receives chopped "一个字/词组" fragments. The buffered tail
   * is only released wholesale on agent_end via flushAll().
   */
  flush(): MappedPiUpdate | undefined {
    const complete = this.takeCompleteSentences();
    return complete === undefined ? undefined : { type: "task.progress", payload: { text: normalizeForSpeech(complete) } };
  }

  /**
   * Emits everything still buffered as length-capped chunks -- called once
   * on agent_end so the final utterance is not lost. Unlike a raw dump,
   * it never emits one giant blob (which VoiceHerald's length cap would
   * reject wholesale); it drains takeCompleteSentences repeatedly, and
   * force-cuts any long sentence-final tail.
   */
  flushAll(): MappedPiUpdate[] {
    const chunks: string[] = [];
    for (;;) {
      const chunk = this.takeCompleteSentences();
      if (chunk !== undefined) {
        chunks.push(chunk);
        continue;
      }
      // No sentence boundary remains in the tail (e.g. a short fragment or
      // a comma-separated list the LLM never punctuated). Emit it: short
      // tails go wholesale, long ones are force-cut at clause breaks so
      // VoiceHerald's length cap never rejects the whole blob.
      if (this.pendingText === "") {
        break;
      }
      const forced = this.cutToChunk(this.pendingText) ?? {
        chunk: this.pendingText,
        remainder: "",
      };
      chunks.push(forced.chunk);
      this.pendingText = forced.remainder;
      if (forced.remainder === "") {
        break;
      }
    }
    return chunks.map((text) => ({ type: "task.progress", payload: { text: normalizeForSpeech(text) } } as MappedPiUpdate));
  }

  private takeCompleteSentences(): string | undefined {
    if (this.pendingText === "") {
      return undefined;
    }
    const match = this.pendingText.match(SENTENCE_END_RE);
    if (!match || match.index === undefined) {
      return undefined;
    }
    const firstEnd = match.index + match[0].length;
    let complete = this.pendingText.slice(0, firstEnd).trim();
    let remainder = this.pendingText.slice(firstEnd);

    // An over-long sentence would be rejected by VoiceHerald's length cap
    // and lost entirely -- split it at clause boundaries (commas/semicolons)
    // so every chunk stays speakable.
    if (complete.length > MAX_CHUNK_LENGTH) {
      let cut = -1;
      CLAUSE_BREAK_RE.lastIndex = 0;
      const clauseMatches = [...complete.matchAll(CLAUSE_BREAK_RE)];
      for (const clause of clauseMatches) {
        if ((clause.index ?? 0) + 1 >= MAX_CHUNK_LENGTH) {
          break;
        }
        cut = (clause.index ?? 0) + 1;
      }
      if (cut > 0) {
        const head = complete.slice(0, cut).trim();
        const tail = complete.slice(cut).trim();
        if (head !== "") {
          complete = head;
          remainder = `${tail}${remainder}`;
        }
      }
    }

    this.pendingText = remainder.trimStart();
    return complete === "" ? undefined : complete;
  }

  /** Cuts `text` at the last clause break within MAX_CHUNK_LENGTH, else hard-cuts. Returns {chunk, remainder}. */
  private cutToChunk(text: string): { chunk: string; remainder: string } | undefined {
    if (text === "") {
      return undefined;
    }
    let cut = -1;
    CLAUSE_BREAK_RE.lastIndex = 0;
    const clauseMatches = [...text.matchAll(CLAUSE_BREAK_RE)];
    for (const clause of clauseMatches) {
      if ((clause.index ?? 0) + 1 >= MAX_CHUNK_LENGTH) {
        break;
      }
      cut = (clause.index ?? 0) + 1;
    }
    if (cut <= 0) {
      cut = Math.min(MAX_CHUNK_LENGTH, text.length);
    }
    const chunk = text.slice(0, cut).trim();
    const remainder = text.slice(cut).trimStart();
    return chunk === "" ? undefined : { chunk, remainder };
  }
}
