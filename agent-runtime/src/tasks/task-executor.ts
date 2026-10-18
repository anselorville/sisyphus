/**
 * Task Executor: the orchestration loop that drives a voice-initiated task
 * from pending → assigned → running → completed/failed/cancelled. Closes
 * the "no execution loop" gap (../README.md "已知缺口").
 *
 * T4 方案 B: accumulates ManagedRoleSession update text internally and
 * constructs the task.completed summary itself — does NOT modify
 * PiEventAdapter or VoiceHerald. Awaits agent_end (mapped by PiEventAdapter
 * to task.completed) before marking the task complete.
 */

import { randomUUID } from "node:crypto";

import type { RealtimeEvent, RealtimeEventType } from "../protocol/events.js";
import type { RoleManifestRegistry } from "../roles/registry.js";
import type { PiRoleSessionManager } from "../roles/session-manager.js";
import type { RoleSessionUpdate } from "../roles/types.js";
import type { ReflexRouter, RouteState } from "../routing/reflex-router.js";
import type { TaskAssimilationDb } from "./task-assimilation.js";
import type { RuntimeWebSocketServer } from "../transport/websocket-server.js";
import type { TaskNest } from "./task-nest.js";
import type { TrafficCommander } from "../voice/traffic-commander.js";
import type { SpeechDirective, VoiceHerald } from "../voice/voice-herald.js";
import type { InfoHub } from "../hub/info-hub.js";
import { LongTaskFillerScheduler } from "../voice/long-task-filler-scheduler.js";
import { ToolAckGenerator } from "../voice/tool-ack-generator.js";

const DEFAULT_ACK_GRACE_MS = 700;
const DEFAULT_GENERAL_ROLE_ID = "general";
const DEFAULT_FILLER_START_MS = 5_000;
const DEFAULT_FILLER_INTERVAL_MS = 10_000;

interface ActiveTaskInfo {
  readonly taskId: string;
  readonly roleId: string;
  readonly interactionId: string;
  cancelled: boolean;
}

export interface TaskExecutorOptions {
  readonly taskNest: TaskNest;
  readonly reflexRouter: ReflexRouter;
  readonly sessionManager: PiRoleSessionManager;
  readonly voiceHerald: VoiceHerald;
  readonly trafficCommander: TrafficCommander;
  readonly server: RuntimeWebSocketServer;
  readonly roleRegistry: RoleManifestRegistry;
  readonly db?: TaskAssimilationDb;
  readonly hub?: InfoHub;
  /** Called after every terminal task event -- used to poke the Scribe so a completed turn immediately triggers a topic sweep instead of waiting for the 30s timer. */
  readonly onTerminal?: () => void;
  readonly ackGraceMs?: number;
  readonly toolAckGenerator?: ToolAckGenerator;
  readonly fillerStartMs?: number;
  readonly fillerIntervalMs?: number;
}

export class TaskExecutor {
  private readonly taskNest: TaskNest;
  private readonly reflexRouter: ReflexRouter;
  private readonly sessionManager: PiRoleSessionManager;
  private readonly voiceHerald: VoiceHerald;
  private readonly trafficCommander: TrafficCommander;
  private readonly server: RuntimeWebSocketServer;
  private readonly roleRegistry: RoleManifestRegistry;
  private readonly db: TaskAssimilationDb | undefined;
  private readonly hub: InfoHub | undefined;
  private readonly onTerminal: (() => void) | undefined;
  private readonly ackGraceMs: number;
  private readonly toolAckGenerator: ToolAckGenerator;
  private readonly fillerStartMs: number;
  private readonly fillerIntervalMs: number;
  private sequence = 0;
  private activeTask: ActiveTaskInfo | undefined;
  private activeFillerScheduler: LongTaskFillerScheduler | undefined;
  private readonly pendingQueue: Array<{ text: string; interactionId: string; sourceEventId?: string }> = [];

  constructor(options: TaskExecutorOptions) {
    this.taskNest = options.taskNest;
    this.reflexRouter = options.reflexRouter;
    this.sessionManager = options.sessionManager;
    this.voiceHerald = options.voiceHerald;
    this.trafficCommander = options.trafficCommander;
    this.server = options.server;
    this.roleRegistry = options.roleRegistry;
    this.db = options.db;
    this.hub = options.hub;
    this.onTerminal = options.onTerminal;
    this.ackGraceMs = options.ackGraceMs ?? DEFAULT_ACK_GRACE_MS;
    this.toolAckGenerator = options.toolAckGenerator ?? new ToolAckGenerator();
    this.fillerStartMs = options.fillerStartMs ?? DEFAULT_FILLER_START_MS;
    this.fillerIntervalMs = options.fillerIntervalMs ?? DEFAULT_FILLER_INTERVAL_MS;
  }

  /** Inbound handler for RuntimeWebSocketServer's onInboundEvent seam. */
  handleInboundEvent = async (event: RealtimeEvent, connectionId: string): Promise<void> => {
    if (event.type === "voice.speech.cancel") {
      this.activeFillerScheduler?.stop();
      return;
    }
    if (event.type !== "voice.transcript.final") return;
    const raw = event.payload["text"];
    const text = typeof raw === "string" ? raw.trim() : "";
    // Filler fragments ("那", "嗯", "啊") from VAD splits at mid-speech
    // pauses are not real requests: answering them produces nonsense turns
    // ("你的话好像没说完？"). Ignore very short utterances entirely.
    if (!text || text.length < 2) return;
    console.log(`[task-executor] inbound transcript "${text.slice(0, 60)}" (event ${event.event_id})`);
    await this.onVoiceTranscript(text, event.interaction_id ?? connectionId, event.event_id);
  };

  /** Routes a final transcript, cancels/steers, or creates + runs a task. */
  async onVoiceTranscript(text: string, interactionId: string, sourceEventId?: string): Promise<string | undefined> {
    this.activeFillerScheduler?.stop();
    const active = this.activeTask;
    const routeState = this.buildRouteState(active);
    const decision = this.reflexRouter.route(text, routeState);

    if (decision.kind === "cancel" || decision.kind === "stop_speech") {
      await this.handleCancel(interactionId);
      return;
    }
    if (decision.kind === "steer" && active) {
      void this.sessionManager.steer(active.roleId, active.taskId, text).catch(() => {});
      return;
    }
    if (decision.kind === "follow_up" && active) {
      void this.sessionManager.followUp(active.roleId, active.taskId, text).catch(() => {});
      return;
    }

    // A fresh instruction while a task is already running: the Pi session
    // can only process one message at a time, so queue this transcript and
    // process it after the active task reaches a terminal state.
    if (active) {
      console.log(`[task-executor] task ${active.taskId} busy, queuing "${text.slice(0, 40)}" (queue=${this.pendingQueue.length + 1})`);
      this.pendingQueue.push({ text, interactionId, sourceEventId });
      return;
    }

    const roleId = decision.roleId ?? DEFAULT_GENERAL_ROLE_ID;
    console.log(`[task-executor] route=${decision.kind} role=${roleId} creating task...`);
    const task = await this.taskNest.create({
      goal: text,
      interactionId,
      metadata: sourceEventId ? { sourceEventId } : {},
    });
    console.log(`[task-executor] created task ${task.id}, assigning...`);
    this.server.broadcast(this.buildEvent("task.created", task.id, interactionId, { goal: task.goal }));
    await this.taskNest.assign(task.id, roleId);
    console.log(`[task-executor] assigned task ${task.id}`);
    this.server.broadcast(this.buildEvent("task.assigned", task.id, interactionId, { role_id: roleId }));

    this.startTask(task.id, roleId, interactionId, text);
    return task.id;
  }

  private buildRouteState(active: ActiveTaskInfo | undefined): RouteState {
    return {
      activeTask: active ? { taskId: active.taskId, roleId: active.roleId } : undefined,
      capabilityProviders: this.roleRegistry.list().map((manifest) => ({
        roleId: manifest.id,
        capabilities: manifest.capabilities,
      })),
    };
  }

  private startTask(taskId: string, roleId: string, interactionId: string, text: string): void {
    const taskInfo: ActiveTaskInfo = { taskId, roleId, interactionId, cancelled: false };
    this.activeTask = taskInfo;
    console.log(`[task-executor] START task ${taskId} role=${roleId} goal="${text.slice(0, 50)}"`);

    // Fire-and-forget: don't block the WebSocket ack on the LLM round-trip.
    void this.runTask(taskInfo, text).catch((error: unknown) => {
      if (!taskInfo.cancelled) {
        const reason = error instanceof Error ? error.message : String(error);
        void this.taskNest.transition(taskInfo.taskId, "failed").catch(() => {});
        this.emitTerminal("task.failed", taskInfo.taskId, taskInfo.interactionId, { reason });
      }
      if (this.activeTask === taskInfo) this.activeTask = undefined;
      this.drainQueue();
    });
  }

  /** Starts the next queued transcript once the active task is terminal. */
  private drainQueue(): void {
    if (this.activeTask) return;
    const next = this.pendingQueue.shift();
    if (!next) return;
    console.log(`[task-executor] DRAIN queue -> "${next.text.slice(0, 40)}" (remaining=${this.pendingQueue.length})`);
    const decision = this.reflexRouter.route(next.text, this.buildRouteState(undefined));
    if (decision.kind === "cancel" || decision.kind === "stop_speech") {
      void this.handleCancel(next.interactionId).catch(() => {});
      return;
    }
    const roleId = decision.roleId ?? DEFAULT_GENERAL_ROLE_ID;
    void (async () => {
      try {
        const task = await this.taskNest.create({
          goal: next.text,
          interactionId: next.interactionId,
          metadata: next.sourceEventId ? { sourceEventId: next.sourceEventId } : {},
        });
        await this.taskNest.assign(task.id, roleId);
        this.startTask(task.id, roleId, next.interactionId, next.text);
      } catch {
        return;
      }
    })();
  }

  /** Drives running → terminal. Subscribes before prompt so no event is missed. */
  private async runTask(taskInfo: ActiveTaskInfo, text: string): Promise<void> {
    const { taskId, roleId, interactionId } = taskInfo;

    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let receiptDelivered = false;
    let accumulatedText = "";
    let deliveredProgressText = "";
    const fillerScheduler = new LongTaskFillerScheduler({
      startDelayMs: this.fillerStartMs,
      intervalMs: this.fillerIntervalMs,
      onSpeak: (fillerText) => {
        const directive = this.voiceHerald.acceptLocalSpeech(fillerText, "progress", taskId);
        if (directive) {
          this.deliverSpeech(directive, taskId, interactionId);
        }
      },
    });
    this.activeFillerScheduler = fillerScheduler;

    // Resolves when PiEventAdapter maps agent_end → task.completed.
    let resolveEnded!: () => void;
    const endPromise = new Promise<void>((resolve) => { resolveEnded = resolve; });
    try {
      await this.taskNest.transition(taskId, "running");

      const finalTranscriptAtMs = Date.now();
      ackTimer = setTimeout(() => {
        if (receiptDelivered || taskInfo.cancelled) return;
        const directive = this.trafficCommander.evaluate(
          { taskId, running: true, finalTranscriptAtMs, transcript: text },
          Date.now(),
        );
        if (directive) {
          receiptDelivered = true;
          this.deliverSpeech(directive, taskId, interactionId);
        }
      }, this.ackGraceMs);

      const manifest = this.roleRegistry.get(roleId);
      if (!manifest) throw new Error(`TaskExecutor: unknown role "${roleId}"`);

      const session = await this.sessionManager.ensure(manifest);
      unsubscribe = session.subscribe((update: RoleSessionUpdate) => {
        if (update.taskId !== undefined && update.taskId !== taskId) return;

        // Accumulate text delta for summary construction. Progress text is
        // already speech-normalized (newlines collapsed) by PiEventAdapter.
        if (update.type === "task.progress" && typeof update.payload["text"] === "string") {
          accumulatedText += update.payload["text"] as string;
        }

        if (update.type === "tool.started") {
          const toolCallId = readString(update.payload["tool_call_id"]) ?? readString(update.payload["tool_name"]) ?? "tool";
          fillerScheduler.begin(toolCallId);
          if (!receiptDelivered) {
            receiptDelivered = true;
            if (ackTimer !== undefined) {
              clearTimeout(ackTimer);
              ackTimer = undefined;
            }
            const toolName = readString(update.payload["tool_name"]) ?? "tool";
            const directive = this.voiceHerald.acceptLocalSpeech(
              this.toolAckGenerator.build(toolName),
              "receipt",
              taskId,
            );
            if (directive) {
              this.deliverSpeech(directive, taskId, interactionId);
            }
          }
          return;
        }

        if (update.type === "tool.completed" || update.type === "tool.failed") {
          const toolCallId = readString(update.payload["tool_call_id"]) ?? readString(update.payload["tool_name"]) ?? "tool";
          fillerScheduler.end(toolCallId);
          return;
        }

        // agent_end (mapped by PiEventAdapter to task.completed) signals the LLM is done.
        // Don't herald it raw — the executor constructs the summary itself.
        if (update.type === "task.completed") {
          fillerScheduler.stop();
          resolveEnded();
          return;
        }

        // All other events go through VoiceHerald for content-safe speech.
        // Receipt acks are deliberately NOT spoken here: the Traffic
        // Commander's 700ms timer owns the ack, so it can build a
        // context-aware one from the user's transcript ("好的，帮你查上海的
        // 天气") instead of the canned "好的，我在处理。".
        if (update.type === "task.assigned") {
          return;
        }
        const event = this.buildEvent(update.type, taskId, interactionId, update.payload);
        const directive = this.voiceHerald.accept(event);
        if (directive) {
          // Any real speech (progress/final/...) means the agent has
          // started answering -- suppress the pending ack timer.
          if (directive.kind === "receipt" || directive.kind === "progress" || directive.kind === "final") {
            receiptDelivered = true;
          }
          if (directive.kind === "progress" && update.type === "task.progress") {
            fillerScheduler.touch();
          }
          const delivered = this.deliverSpeech(directive, taskId, interactionId);
          if (delivered && directive.kind === "progress" && update.type === "task.progress") {
            deliveredProgressText += directive.text;
          }
        } else if (update.type === "task.progress" && typeof update.payload["text"] === "string") {
          const t = update.payload["text"] as string;
          console.log(`[task-executor] HERALD-REJECT progress "${t.slice(0, 60)}" (len=${t.length}, newlines=${(t.match(/\n/g) ?? []).length})`);
        }
      });

      const injectedText = await this.buildPromptWithMemories(text);
      await this.sessionManager.prompt(roleId, taskId, injectedText);
      if (taskInfo.cancelled) return;

      // Wait for the LLM to signal completion (agent_end).
      await endPromise;
      if (taskInfo.cancelled) return;

      const summary = accumulatedText.trim();
      const payload: Record<string, unknown> = summary.length > 0 ? { summary } : {};
      await this.taskNest.transition(taskId, "completed");
      this.emitTerminal("task.completed", taskId, interactionId, payload, deliveredProgressText);
    } catch (error) {
      if (taskInfo.cancelled) return;
      const reason = error instanceof Error ? error.message : String(error);
      // Transition may fail if already terminal — swallow.
      try { await this.taskNest.transition(taskId, "failed"); } catch { /* ok */ }
      this.emitTerminal("task.failed", taskId, interactionId, { reason });
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
      fillerScheduler.stop();
      if (this.activeFillerScheduler === fillerScheduler) this.activeFillerScheduler = undefined;
      this.trafficCommander.forget(taskId);
      unsubscribe?.();
      if (this.activeTask === taskInfo) this.activeTask = undefined;
      this.drainQueue();
    }
  }

  /** Aborts the active task and transitions it to cancelled. */
  private async handleCancel(interactionId: string): Promise<void> {
    const taskInfo = this.activeTask;
    if (!taskInfo) return;

    this.activeFillerScheduler?.stop();
    taskInfo.cancelled = true;
    try { await this.sessionManager.abort(taskInfo.roleId, taskInfo.taskId); } catch { /* ok */ }
    try { await this.taskNest.transition(taskInfo.taskId, "cancelled"); } catch { /* ok */ }

    this.emitTerminal("task.cancelled", taskInfo.taskId, interactionId, {});
  }

  /**
   * Broadcasts a terminal event and passes it through VoiceHerald for speech.
   * When `deliveredProgressText` is provided and the herald's directive text is
   * contained in it, the speech is skipped: that utterance was already
   * streamed out as progress (sentence-aware flush), and speaking the same
   * text again as a "final" summary would duplicate it on TTS.
   */
  private emitTerminal(
    type: RealtimeEventType,
    taskId: string,
    interactionId: string,
    payload: Record<string, unknown>,
    deliveredProgressText?: string,
  ): void {
    const event = this.buildEvent(type, taskId, interactionId, payload);
    const directive = this.voiceHerald.accept(event);
    const skip = Boolean(
      directive &&
      deliveredProgressText &&
      directive.text.trim() !== "" &&
      deliveredProgressText.includes(directive.text.trim()),
    );
    const suppressUnrepeatedCompletion = Boolean(
      type === "task.completed" &&
      deliveredProgressText?.trim() !== "" &&
      directive?.kind === "final" &&
      !skip,
    );
    console.log(`[task-executor] emitTerminal ${type} directive=${directive?.kind ?? "none"} skipSpeech=${skip} already=${deliveredProgressText?.length ?? 0}chars`);
    if (directive && !skip && !suppressUnrepeatedCompletion) {
      this.deliverSpeech(directive, taskId, interactionId);
    }
    try { this.server.broadcast(event); } catch { /* server closed */ }
    this.onTerminal?.();
  }

  private deliverSpeech(directive: SpeechDirective, taskId: string, interactionId: string): boolean {
    console.log(`[task-executor] SPEECH kind=${directive.kind} "${directive.text.slice(0, 60)}"`);
    const event = this.buildEvent("voice.speech.enqueue", taskId, interactionId, {
      text: directive.text,
      kind: directive.kind,
    });
    try {
      this.server.broadcast(event);
      return true;
    } catch {
      return false;
    }
  }

  private buildEvent(
    type: RealtimeEventType,
    taskId: string,
    interactionId: string,
    payload: Record<string, unknown>,
  ): RealtimeEvent {
    this.sequence += 1;
    return {
      event_id: randomUUID(),
      sequence: this.sequence,
      interaction_id: interactionId,
      task_id: taskId,
      source: "swarm",
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  private async buildPromptWithMemories(text: string): Promise<string> {
    const context: string[] = [];
    if (this.hub) {
      const topicContext = this.hub.buildTopicContext();
      if (topicContext) {
        context.push(topicContext);
      }
    }
    if (this.db) {
      try {
        const { results } = await this.db.request({ type: "memory.search", query: text, limit: 5 });
        if (results.length > 0) {
          const memories = results.map((r) => `- ${r.value}`).join("\n");
          context.push(`[Remembered context]\n${memories}`);
        }
      } catch {
        // memory is best-effort
      }
    }
    if (context.length === 0) return text;
    return `${context.join("\n\n")}\n\n${text}`;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
