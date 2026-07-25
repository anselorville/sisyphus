/**
 * Runtime-side WebSocket server: the local transport boundary between this
 * sidecar and the Python Pipecat media pipeline (see ./outbound-queue.ts,
 * whose own doc comment calls this "a later task" -- this is that task).
 *
 * Binds to 127.0.0.1 only, on purpose: this is a loopback bridge between two
 * local processes, never a network-facing service.
 *
 * Each connection gets its own bounded, priority-ordered OutboundEventQueue
 * (from ./outbound-queue.ts) so a burst of broadcasts coalesces/evicts per
 * that module's already-established policy instead of growing without
 * bound. Draining is deferred to the next event-loop tick (`setImmediate`)
 * rather than happening inline inside `broadcast()`/`push()`, specifically
 * so same-tick bursts (e.g. several `task.progress` updates for one task
 * fired back-to-back) actually sit in the queue long enough for coalescing
 * to do its job, and so `queueDepth` is ever observably non-zero for the
 * telemetry gauge callers are expected to register (see
 * ../telemetry/runtime-metrics.ts).
 *
 * Per-connection dedup: inbound events are tracked by `event_id` in a
 * bounded FIFO set. A duplicate (e.g. Python resending after a dropped ack
 * on reconnect) is still ack'd -- Python needs to know the bytes arrived --
 * but the injected `onInboundEvent` handler (the Task Nest, in later
 * wiring) fires at most once per unique event_id.
 */

import type { IncomingMessage } from "node:http";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { decodeEvent, encodeEvent } from "../protocol/schema.js";
import type { RealtimeEvent } from "../protocol/events.js";
import { OutboundEventQueue } from "./outbound-queue.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_TRACKED_INBOUND_EVENT_IDS = 2048;

/** Transport-level control frame, distinct from the cross-language RealtimeEvent envelope (see ../protocol/schema.ts) -- acks never cross into Task Nest / application logic. */
export interface AckMessage {
  readonly kind: "ack";
  readonly sequence: number;
  readonly duplicate: boolean;
}

export interface ConnectionSequenceState {
  /** Highest inbound `sequence` this connection has had ack'd so far. */
  readonly lastAckedSequence: number;
  /** Highest `sequence` among outbound events actually written to this connection's socket (i.e. left the bounded queue and were transmitted) -- not merely queued. */
  readonly lastSentDurableSequence: number;
}

export class RuntimeWebSocketServerClosedError extends Error {
  constructor(message = "the runtime WebSocket server is closed") {
    super(message);
    this.name = "RuntimeWebSocketServerClosedError";
  }
}

interface ConnectionState {
  readonly socket: WebSocket;
  readonly outbound: OutboundEventQueue;
  readonly seenInboundEventIds: Set<string>;
  lastAckedSequence: number;
  lastSentDurableSequence: number;
  pumpScheduled: boolean;
}

export interface RuntimeWebSocketServerOptions {
  /** Port to listen on; use 0 for an OS-assigned ephemeral port (see `.address`). Host is always 127.0.0.1 -- not configurable, so this constraint can't be violated by accident. */
  readonly port: number;
  readonly outboundQueueCapacity?: number;
  /** Bounded cap on the per-connection inbound dedup set. */
  readonly maxTrackedInboundEventIds?: number;
  /** Invoked at most once per unique inbound `event_id` on a given connection -- the seam later wiring uses to feed the Task Nest. */
  readonly onInboundEvent?: (event: RealtimeEvent, connectionId: string) => void | Promise<void>;
  readonly onConnectionClose?: (connectionId: string) => void;
}

const DEFAULT_OUTBOUND_QUEUE_CAPACITY = 1024;

export class RuntimeWebSocketServer {
  private readonly port: number;
  private readonly outboundQueueCapacity: number;
  private readonly maxTrackedInboundEventIds: number;
  private readonly onInboundEvent:
    | ((event: RealtimeEvent, connectionId: string) => void | Promise<void>)
    | undefined;
  private readonly onConnectionClose: ((connectionId: string) => void) | undefined;
  private readonly connections = new Map<string, ConnectionState>();
  private wss: WebSocketServer | undefined;
  private nextConnectionId = 1;
  private closed = false;

  constructor(options: RuntimeWebSocketServerOptions) {
    this.port = options.port;
    this.outboundQueueCapacity = options.outboundQueueCapacity ?? DEFAULT_OUTBOUND_QUEUE_CAPACITY;
    this.maxTrackedInboundEventIds = options.maxTrackedInboundEventIds ?? DEFAULT_MAX_TRACKED_INBOUND_EVENT_IDS;
    this.onInboundEvent = options.onInboundEvent;
    this.onConnectionClose = options.onConnectionClose;
  }

  /** Starts listening on 127.0.0.1. Idempotent -- a second call while already started is a no-op. */
  async start(): Promise<void> {
    if (this.wss) {
      return;
    }
    if (this.closed) {
      throw new RuntimeWebSocketServerClosedError();
    }

    const server = new WebSocketServer({ host: LOOPBACK_HOST, port: this.port });
    this.wss = server;
    server.on("connection", (socket: WebSocket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
  }

  /** The bound address once `start()` has resolved, or `undefined` before/after that. */
  get address(): { readonly host: string; readonly port: number } | undefined {
    const addr = this.wss?.address();
    if (!addr || typeof addr === "string") {
      return undefined;
    }
    return { host: addr.address, port: addr.port };
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** IDs of every currently-connected client, in connection order. */
  get connectionIds(): readonly string[] {
    return [...this.connections.keys()];
  }

  /** Total events currently queued (not yet written to a socket) across every connection -- intended as a RuntimeMetrics queue-depth gauge. */
  get totalQueueDepth(): number {
    let total = 0;
    for (const state of this.connections.values()) {
      total += state.outbound.size;
    }
    return total;
  }

  getConnectionSequenceState(connectionId: string): ConnectionSequenceState | undefined {
    const state = this.connections.get(connectionId);
    if (!state) {
      return undefined;
    }
    return { lastAckedSequence: state.lastAckedSequence, lastSentDurableSequence: state.lastSentDurableSequence };
  }

  /** Enqueues `event` for delivery to every currently-connected client. Actual socket writes happen on the next tick (see module doc comment) via each connection's bounded OutboundEventQueue. */
  broadcast(event: RealtimeEvent): void {
    if (this.closed) {
      throw new RuntimeWebSocketServerClosedError();
    }
    for (const state of this.connections.values()) {
      this.enqueueForConnection(state, event);
    }
  }

  /** Enqueues `event` for exactly one connection. Returns false if the connection is unknown (already closed/gone is not an error -- just nothing to do). */
  sendTo(connectionId: string, event: RealtimeEvent): boolean {
    if (this.closed) {
      throw new RuntimeWebSocketServerClosedError();
    }
    const state = this.connections.get(connectionId);
    if (!state) {
      return false;
    }
    this.enqueueForConnection(state, event);
    return true;
  }

  /** Closes every connection's queue and socket, then the underlying server. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const state of this.connections.values()) {
      state.outbound.close();
      state.socket.close(1001, "server shutting down");
    }
    this.connections.clear();

    const server = this.wss;
    this.wss = undefined;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handleConnection(socket: WebSocket): void {
    const connectionId = `conn-${this.nextConnectionId}`;
    this.nextConnectionId += 1;

    const state: ConnectionState = {
      socket,
      outbound: new OutboundEventQueue(this.outboundQueueCapacity),
      seenInboundEventIds: new Set<string>(),
      lastAckedSequence: -1,
      lastSentDurableSequence: -1,
      pumpScheduled: false,
    };
    this.connections.set(connectionId, state);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      void this.handleInboundMessage(connectionId, state, data, isBinary);
    });
    socket.on("close", () => {
      state.outbound.close();
      this.connections.delete(connectionId);
      this.onConnectionClose?.(connectionId);
    });
    socket.on("error", () => {
      // A transport-level error on one connection must never take down the
      // server; "close" always follows and does the actual cleanup.
    });
  }

  private async handleInboundMessage(
    connectionId: string,
    state: ConnectionState,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      // The event channel is JSON text only -- raw audio never crosses it
      // (enforced independently at the payload level by
      // ../protocol/schema.ts's assertPayloadIsSafe).
      return;
    }

    let event: RealtimeEvent;
    try {
      event = decodeEvent(rawDataToString(data));
    } catch {
      return; // Malformed frame: nothing to ack, nothing to dedup, nothing to hand to the Task Nest.
    }

    const isDuplicate = state.seenInboundEventIds.has(event.event_id);
    if (!isDuplicate) {
      this.rememberInboundEventId(state, event.event_id);
      try {
        await this.onInboundEvent?.(event, connectionId);
      } catch {
        // Python already delivered the bytes; a handler failure means the
        // runtime failed to *act* on them, which must not block the ack.
      }
    }

    state.lastAckedSequence = Math.max(state.lastAckedSequence, event.sequence);
    this.sendAck(state, event.sequence, isDuplicate);
  }

  private sendAck(state: ConnectionState, sequence: number, duplicate: boolean): void {
    if (state.socket.readyState !== state.socket.OPEN) {
      return;
    }
    const ack: AckMessage = { kind: "ack", sequence, duplicate };
    state.socket.send(JSON.stringify(ack));
  }

  private rememberInboundEventId(state: ConnectionState, eventId: string): void {
    if (state.seenInboundEventIds.size >= this.maxTrackedInboundEventIds) {
      const oldest = state.seenInboundEventIds.values().next().value;
      if (oldest !== undefined) {
        state.seenInboundEventIds.delete(oldest);
      }
    }
    state.seenInboundEventIds.add(eventId);
  }

  private enqueueForConnection(state: ConnectionState, event: RealtimeEvent): void {
    if (state.outbound.isClosed) {
      return;
    }
    try {
      state.outbound.push(event);
    } catch {
      return; // OutboundQueueOverflowError: full with nothing lower-priority to evict -- drop rather than crash the transport.
    }
    this.schedulePump(state);
  }

  private schedulePump(state: ConnectionState): void {
    if (state.pumpScheduled) {
      return;
    }
    state.pumpScheduled = true;
    setImmediate(() => {
      state.pumpScheduled = false;
      this.drainConnection(state);
    });
  }

  private drainConnection(state: ConnectionState): void {
    if (state.socket.readyState !== state.socket.OPEN) {
      return;
    }
    for (let event = state.outbound.shift(); event !== undefined; event = state.outbound.shift()) {
      state.socket.send(encodeEvent(event));
      if (event.sequence > state.lastSentDurableSequence) {
        state.lastSentDurableSequence = event.sequence;
      }
    }
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
