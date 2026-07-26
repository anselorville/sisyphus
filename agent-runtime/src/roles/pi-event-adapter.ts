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
   * Drains buffered text_delta text into one aggregated `task.progress`
   * update, or returns `undefined` if nothing is pending. Intended to be
   * called on the owner's flushIntervalMs timer -- never per-token.
   */
  flush(): MappedPiUpdate | undefined {
    if (this.pendingText === "") {
      return undefined;
    }
    const text = this.pendingText;
    this.pendingText = "";
    return { type: "task.progress", payload: { text } };
  }
}
