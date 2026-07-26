import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RealtimeEvent } from "../../src/protocol/events.js";
import { decodeEvent, encodeEvent } from "../../src/protocol/schema.js";
import {
  RuntimeWebSocketServer,
  RuntimeWebSocketServerClosedError,
  type AckMessage,
  type RuntimeWebSocketServerOptions,
} from "../../src/transport/websocket-server.js";

let eventCounter = 0;

function makeEvent(overrides: Partial<RealtimeEvent> & Pick<RealtimeEvent, "type">): RealtimeEvent {
  eventCounter += 1;
  return {
    event_id: `evt-${eventCounter}`,
    sequence: eventCounter,
    source: "swarm",
    timestamp: new Date(0).toISOString(),
    payload: {},
    ...overrides,
  };
}

function once<T = unknown>(target: WebSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    target.once(event, (arg: T) => resolve(arg));
  });
}

async function connectClient(port: number): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, "open");
  return client;
}

function parseFrame(raw: unknown): AckMessage | RealtimeEvent {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const parsed: unknown = JSON.parse(text);
  if (parsed && typeof parsed === "object" && (parsed as { kind?: unknown }).kind === "ack") {
    return parsed as AckMessage;
  }
  return decodeEvent(text);
}

const openServers: RuntimeWebSocketServer[] = [];
const openClients: WebSocket[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    client.close();
  }
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function startServer(
  options: Partial<RuntimeWebSocketServerOptions> = {},
): Promise<RuntimeWebSocketServer> {
  const server = new RuntimeWebSocketServer({ port: 0, ...options });
  openServers.push(server);
  await server.start();
  return server;
}

function trackClient(client: WebSocket): WebSocket {
  openClients.push(client);
  return client;
}

describe("binding", () => {
  it("listens only on 127.0.0.1", async () => {
    const server = await startServer();

    expect(server.address?.host).toBe("127.0.0.1");
    expect(server.address?.port).toBeGreaterThan(0);
  });
});

describe("broadcast", () => {
  it("delivers a broadcast event to a connected client", async () => {
    const server = await startServer();
    const client = trackClient(await connectClient(server.address!.port));
    await vi.waitFor(() => expect(server.connectionCount).toBe(1));

    const event = makeEvent({ type: "task.created", task_id: "t1" });
    server.broadcast(event);

    const raw = await once(client, "message");
    const received = parseFrame(raw);

    expect(received).toEqual(event);
  });

  it("delivers to every currently-connected client", async () => {
    const server = await startServer();
    const clientA = trackClient(await connectClient(server.address!.port));
    const clientB = trackClient(await connectClient(server.address!.port));
    await vi.waitFor(() => expect(server.connectionCount).toBe(2));

    const event = makeEvent({ type: "task.created", task_id: "t1" });
    server.broadcast(event);

    const [rawA, rawB] = await Promise.all([once(clientA, "message"), once(clientB, "message")]);

    expect(parseFrame(rawA)).toEqual(event);
    expect(parseFrame(rawB)).toEqual(event);
  });

  it("queues synchronously and drains on a later tick, so same-tick coalescing has a chance to apply", async () => {
    const server = await startServer();
    const client = trackClient(await connectClient(server.address!.port));
    await vi.waitFor(() => expect(server.connectionCount).toBe(1));

    server.broadcast(makeEvent({ type: "task.created", task_id: "t1" }));
    expect(server.totalQueueDepth).toBe(1);

    await once(client, "message");
    expect(server.totalQueueDepth).toBe(0);
  });

  it("throws once the server itself is closed", async () => {
    const server = await startServer();
    await server.close();

    expect(() => server.broadcast(makeEvent({ type: "task.created" }))).toThrow(RuntimeWebSocketServerClosedError);
  });
});

describe("inbound ack + dedup-on-reconnect", () => {
  it("acks every inbound event, including duplicates", async () => {
    const server = await startServer();
    const client = trackClient(await connectClient(server.address!.port));
    await vi.waitFor(() => expect(server.connectionCount).toBe(1));

    const event = makeEvent({ type: "task.progress", task_id: "t1" });

    const firstAck = once<Buffer>(client, "message");
    client.send(encodeEvent(event));
    const first = (await firstAck.then(parseFrame)) as AckMessage;
    expect(first).toEqual({ kind: "ack", sequence: event.sequence, duplicate: false });

    const secondAck = once<Buffer>(client, "message");
    client.send(encodeEvent(event)); // exact resend: e.g. Python retrying after a dropped ack
    const second = (await secondAck.then(parseFrame)) as AckMessage;
    expect(second).toEqual({ kind: "ack", sequence: event.sequence, duplicate: true });
  });

  it("invokes onInboundEvent at most once per unique event_id even when the event is resent", async () => {
    const handler = vi.fn();
    const server = await startServer({ onInboundEvent: handler });
    const client = trackClient(await connectClient(server.address!.port));
    await vi.waitFor(() => expect(server.connectionCount).toBe(1));

    const event = makeEvent({ type: "task.progress", task_id: "t1" });

    const ack1 = once(client, "message");
    client.send(encodeEvent(event));
    await ack1;

    const ack2 = once(client, "message");
    client.send(encodeEvent(event));
    await ack2;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event, expect.any(String));
  });

  it("still acks a duplicate even when onInboundEvent rejects for the original", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("task nest exploded"));
    const server = await startServer({ onInboundEvent: handler });
    const client = trackClient(await connectClient(server.address!.port));
    await vi.waitFor(() => expect(server.connectionCount).toBe(1));

    const event = makeEvent({ type: "task.progress", task_id: "t1" });

    const ack1 = once<Buffer>(client, "message");
    client.send(encodeEvent(event));
    expect((await ack1.then(parseFrame)) as AckMessage).toMatchObject({ duplicate: false });

    const ack2 = once<Buffer>(client, "message");
    client.send(encodeEvent(event));
    expect((await ack2.then(parseFrame)) as AckMessage).toMatchObject({ duplicate: true });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("tracks lastAckedSequence as the high-water mark of inbound sequences", async () => {
    const server = await startServer();
    const client = trackClient(await connectClient(server.address!.port));
    await vi.waitFor(() => expect(server.connectionCount).toBe(1));

    for (const type of ["voice.user.started", "voice.transcript.partial", "voice.transcript.final"] as const) {
      const ack = once(client, "message");
      client.send(encodeEvent(makeEvent({ type })));
      await ack;
    }

    const connectionId = server.connectionIds[0];
    const state = connectionId ? server.getConnectionSequenceState(connectionId) : undefined;

    expect(state?.lastAckedSequence).toBe(eventCounter);
  });
});

describe("lastSentDurableSequence", () => {
  it("tracks the highest sequence actually written to the socket", async () => {
    const server = await startServer();
    const client = trackClient(await connectClient(server.address!.port));
    await vi.waitFor(() => expect(server.connectionCount).toBe(1));

    const connectionId = server.connectionIds[0];
    if (!connectionId) {
      throw new Error("expected a connection id to be tracked after connecting a client");
    }

    const first = makeEvent({ type: "task.created", task_id: "t1" });
    const messageOne = once(client, "message");
    server.broadcast(first);
    await messageOne;

    expect(server.getConnectionSequenceState(connectionId)?.lastSentDurableSequence).toBe(first.sequence);

    const second = makeEvent({ type: "task.completed", task_id: "t1" });
    const messageTwo = once(client, "message");
    server.broadcast(second);
    await messageTwo;

    expect(server.getConnectionSequenceState(connectionId)?.lastSentDurableSequence).toBe(second.sequence);
  });
});

describe("close path", () => {
  it("is idempotent", async () => {
    const server = await startServer();
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("closes connected clients", async () => {
    const server = await startServer();
    const client = trackClient(await connectClient(server.address!.port));
    await vi.waitFor(() => expect(server.connectionCount).toBe(1));

    const closeEvent = once(client, "close");
    await server.close();
    await closeEvent;

    expect(server.connectionCount).toBe(0);
  });

  it("rejects a start() call after close() with RuntimeWebSocketServerClosedError", async () => {
    const server = await startServer();
    await server.close();

    await expect(server.start()).rejects.toThrow(RuntimeWebSocketServerClosedError);
  });
});
