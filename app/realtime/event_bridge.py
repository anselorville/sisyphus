"""WebSocket bridge from the Pipecat media plane to the TypeScript agent-runtime sidecar.

`SidecarEventBridge` is the *only* thing on the Python side allowed to touch
the local WebSocket to the sidecar (see `.proj-init/04-...software-design.md`
section 10.2). It owns two long-lived asyncio tasks for the lifetime of the
bridge:

- sender: drains a `BoundedEventQueue` (reused from `.queueing`, so the same
  CRITICAL/DURABLE/COALESCIBLE priority and overflow rules apply here as
  everywhere else in the realtime plane) and writes wire frames.
- receiver: owns the connect/reconnect lifecycle (it is the task actually
  blocked on I/O, so it is the one positioned to notice a dead connection),
  parses inbound frames, and dispatches acks / sidecar-originated events.

Protocol: every outbound event keeps the caller-supplied `RealtimeEvent.sequence`
as its identity. DURABLE-priority sends are held in a capacity-bounded ordered
dict until the sidecar acks them, and are resent (unchanged, including their
original sequence number) in order after every reconnect -- see
`_remember_pending`/`_resend_pending`. Inbound sidecar events are deduplicated
by sequence in a similar bounded structure before being fanned out to
`events()` subscribers, and are ack'd back so the sidecar can drop them from
its own durable buffer.

Hard limits enforced here (never relaxed by callers): 64KiB per encoded event,
and PCM/raw audio can never be part of a payload -- audio only exists inside
the Python/Pipecat process, never on this bridge. See `_validate_outbound_event`.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import OrderedDict
from collections.abc import AsyncIterator
from typing import Any

import msgspec
from loguru import logger
from websockets.asyncio.client import ClientConnection, connect as ws_connect
from websockets.exceptions import ConnectionClosed

from .events import RealtimeEvent, encode_event
from .queueing import BoundedEventQueue, EventPriority, QueueClosed

# A single event's own encoded size, not the wire envelope around it (see
# `_MAX_WIRE_FRAME_BYTES` below for the transport-level ceiling that leaves
# room for that envelope).
MAX_EVENT_BYTES = 64 * 1024

# websockets' `max_size` bounds the whole wire frame. Outbound event frames
# are a bare RealtimeEvent (see `_transmit`) with no extra wrapper, so this
# ceiling could equal MAX_EVENT_BYTES exactly -- the 4KiB headroom is kept
# anyway as slack for the small `{"kind":"ack",...}` control frames (see
# `_send_ack`) and any other unforeseen small non-event frame.
_MAX_WIRE_FRAME_BYTES = MAX_EVENT_BYTES + 4096

_RECONNECT_INITIAL_BACKOFF_SECONDS = 0.2
_RECONNECT_MAX_BACKOFF_SECONDS = 5.0

# Bounded wait for the sender task to drain whatever is still queued (and
# flush already-pending DURABLE events) during close(). Best-effort: if the
# sidecar is unreachable there is nothing to flush *to*, so this must never
# block shutdown indefinitely.
_CLOSE_FLUSH_TIMEOUT_SECONDS = 2.0

# Dict keys (case-insensitive) that, by name alone, signal an attempt to put
# raw audio on the wire -- checked regardless of the value's type, since a
# base64-encoded string under a key like "pcm" is just as much a violation of
# "audio never crosses this bridge" as literal bytes would be.
_AUDIO_PAYLOAD_KEYS = frozenset({"pcm", "audio", "audio_bytes", "audio_data", "raw_audio"})


def _reject_audio_payload(value: Any, *, key: str | None = None) -> None:
    """Recursively raise if `value` looks like it carries PCM/raw audio.

    Walks dicts/lists/tuples looking for either a blocklisted key name (see
    `_AUDIO_PAYLOAD_KEYS`) or a raw `bytes`/`bytearray` value anywhere in the
    payload tree.
    """
    if key is not None and key.lower() in _AUDIO_PAYLOAD_KEYS:
        raise ValueError(
            f"event payload key {key!r} looks like raw PCM audio; "
            "audio must never cross the sidecar event bridge"
        )
    if isinstance(value, (bytes, bytearray)):
        raise ValueError(
            "event payload contains raw bytes (PCM audio?); "
            "audio must never cross the sidecar event bridge"
        )
    if isinstance(value, dict):
        for child_key, child_value in value.items():
            _reject_audio_payload(child_value, key=child_key)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _reject_audio_payload(item, key=key)


def _validate_outbound_event(event: RealtimeEvent) -> None:
    """Enforce the two hard limits on anything sent through the bridge."""
    _reject_audio_payload(event.payload)
    size = len(encode_event(event))
    if size > MAX_EVENT_BYTES:
        raise ValueError(
            f"event {event.event_id!r} is {size} bytes, exceeds the "
            f"{MAX_EVENT_BYTES}-byte (64KiB) per-event limit"
        )


def _queue_depth(queue: BoundedEventQueue) -> int:
    """Best-effort introspection into a BoundedEventQueue's current depth.

    BoundedEventQueue (app/realtime/queueing.py) doesn't expose a public size
    accessor. Reaching into its private `_size()` here -- rather than keeping
    a second, independently-tracked counter on the bridge -- is deliberate:
    `put()` can coalesce or silently drop a COALESCIBLE event, so a counter
    incremented on every successful `put()` call would drift from the truth.
    Reading the queue's own authoritative state cannot drift.
    """
    return queue._size()  # noqa: SLF001 -- see docstring


class SidecarEventBridge:
    """Bridges realtime media-plane events to/from the TypeScript agent-runtime sidecar.

    Usage: `await bridge.start()` once; `await bridge.send(event, priority=...)`
    for outbound events; `async for event in bridge.events():` per inbound
    subscriber; `await bridge.close()` once, on shutdown.
    """

    def __init__(self, url: str, *, capacity: int = 1024) -> None:
        self._url = url
        self._capacity = capacity
        self._outbound = BoundedEventQueue(capacity=capacity)

        # sequence -> event, for DURABLE sends not yet ack'd by the sidecar.
        # Populated at first transmit attempt (not at send()-time -- see
        # _run_sender) so a reconnect never double-sends an event that was
        # queued locally but never actually went out yet.
        self._pending_acks: OrderedDict[int, RealtimeEvent] = OrderedDict()

        # sequence -> priority, populated by send() and consumed exactly once
        # by the sender when that event is actually dequeued, so the sender
        # can decide durability without re-deriving it from the queue's own
        # (unrelated) priority-upgrade rules.
        self._priority_by_sequence: dict[int, EventPriority] = {}

        # Bounded dedup window for inbound sidecar events.
        self._seen_inbound_sequences: OrderedDict[int, None] = OrderedDict()

        self._subscribers: set[asyncio.Queue[RealtimeEvent | None]] = set()

        self._connection: ClientConnection | None = None
        self._connection_ready = asyncio.Event()
        self._send_lock = asyncio.Lock()

        self._sender_task: asyncio.Task[None] | None = None
        self._receiver_task: asyncio.Task[None] | None = None
        self._closed = False

    @property
    def queue_depth(self) -> int:
        """Current depth of the local outbound queue (see `_queue_depth`)."""
        return _queue_depth(self._outbound)

    @property
    def is_connected(self) -> bool:
        """Whether the bridge currently holds a live connection to the sidecar.

        Mirrors the same state the sender awaits on (`_connection_ready`)
        before transmitting -- never blocks, never touches the network,
        just reflects the receiver task's current view of the connection.
        Used by `GET /api/agent-runtime/status` (app/server.py) to report
        sidecar connectivity, and by tests that need to wait for a
        (re)connection instead of guessing with a fixed sleep.
        """
        return self._connection is not None

    async def start(self) -> None:
        """Start the sender/receiver tasks. Never blocks on the sidecar
        actually being reachable -- connecting happens lazily, with retry,
        inside the receiver task."""
        if self._sender_task is not None or self._receiver_task is not None:
            return
        self._closed = False
        self._sender_task = asyncio.create_task(self._run_sender(), name="sidecar-bridge-sender")
        self._receiver_task = asyncio.create_task(self._run_receiver(), name="sidecar-bridge-receiver")

    async def send(self, event: RealtimeEvent, priority: EventPriority = EventPriority.DURABLE) -> None:
        """Enqueue `event` for delivery to the sidecar.

        Defaults to DURABLE (the safe choice: never silently dropped) --
        pass `EventPriority.COALESCIBLE` explicitly for high-frequency
        ephemeral events (partial transcripts, progress ticks) and
        `EventPriority.CRITICAL` for latency-sensitive control events that
        should jump the queue but need not survive a reconnect (e.g.
        `voice.speech.cancel`, where replaying a stale cancel after the fact
        would be wrong). Raises ValueError if the event is oversized or its
        payload looks like it carries raw audio; raises QueueClosed if the
        bridge is closed or closing.
        """
        _validate_outbound_event(event)
        self._priority_by_sequence[event.sequence] = priority
        try:
            await self._outbound.put(event, priority)
        except QueueClosed:
            self._priority_by_sequence.pop(event.sequence, None)
            raise

    async def events(self) -> AsyncIterator[RealtimeEvent]:
        """Async-iterate inbound, deduplicated sidecar-originated events.

        Each call creates an independent subscription (its own bounded
        queue); `close()` releases every outstanding subscription so no
        `async for` loop over this is ever left dangling.
        """
        subscriber: asyncio.Queue[RealtimeEvent | None] = asyncio.Queue(maxsize=self._capacity)
        self._subscribers.add(subscriber)
        try:
            while True:
                event = await subscriber.get()
                if event is None:
                    return
                yield event
        finally:
            self._subscribers.discard(subscriber)

    async def close(self) -> None:
        """Stop accepting new work, flush what's already queued (best
        effort, bounded), then close the connection and release everything.

        Cancels both tasks cleanly and clears all subscriptions -- safe to
        call even if `start()` was never called, and safe to call twice.
        """
        if self._closed and self._sender_task is None and self._receiver_task is None:
            return
        self._closed = True

        # Phase 1: stop accepting new work. Already-queued events remain
        # available to the sender via get() until the queue is drained.
        await self._outbound.close()

        sender_task, self._sender_task = self._sender_task, None
        receiver_task, self._receiver_task = self._receiver_task, None

        # Phase 2: give the sender a bounded window to flush whatever was
        # already queued (including a final attempt at pending DURABLE
        # events) before we force things closed.
        if sender_task is not None:
            with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(sender_task, timeout=_CLOSE_FLUSH_TIMEOUT_SECONDS)

        for task in (sender_task, receiver_task):
            if task is not None and not task.done():
                task.cancel()
        for task in (sender_task, receiver_task):
            if task is not None:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task

        # Phase 3: close the connection itself.
        connection, self._connection = self._connection, None
        self._connection_ready.clear()
        if connection is not None:
            with contextlib.suppress(Exception):
                await connection.close()

        for subscriber in list(self._subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                subscriber.put_nowait(None)
        self._subscribers.clear()

    # -- sender -----------------------------------------------------------

    async def _run_sender(self) -> None:
        while True:
            try:
                event = await self._outbound.get()
            except QueueClosed:
                return

            priority = self._priority_by_sequence.pop(event.sequence, EventPriority.COALESCIBLE)

            await self._connection_ready.wait()
            connection = self._connection
            if connection is None:
                continue  # defensive: connection cleared between wait() and here

            try:
                await self._transmit(connection, event)
            except asyncio.CancelledError:
                raise
            except (OSError, ConnectionClosed) as exc:
                # Register as pending *after* the attempt (success or
                # failure), never before: _resend_pending runs at the start
                # of every connection, including this event's very first
                # one, and registering earlier would race it into sending
                # this event a second time before the sender's own first
                # attempt even happened.
                logger.debug(f"sidecar bridge failed to send event {event.event_id}: {exc!r}")
                if priority is EventPriority.DURABLE:
                    self._remember_pending(event)
                continue

            if priority is EventPriority.DURABLE:
                self._remember_pending(event)

    async def _transmit(self, connection: ClientConnection, event: RealtimeEvent) -> None:
        # Wire shape is a *bare* RealtimeEvent -- no envelope -- per
        # .proj-init/04-...software-design.md section 10.3's own worked
        # example, and matching what the TypeScript sidecar's
        # decodeEvent()/encodeEvent() (agent-runtime/src/protocol/schema.ts)
        # actually parse/produce: `decodeEvent` requires event_id/sequence/
        # source/type/timestamp/payload as *top-level* properties, and
        # rejects (ProtocolValidationError) anything wrapped in an outer
        # object. `encode_event` (app/realtime/events.py) already produces
        # exactly this shape -- reuse it rather than re-encoding by hand.
        #
        # `text=True` is equally load-bearing, not cosmetic: `encode_event`
        # (like `msgspec.json.encode`) returns `bytes`, and websockets' own
        # `send()` sends a bytes-like object as a *binary* WebSocket frame
        # by default (see its docstring). RuntimeWebSocketServer treats
        # every binary frame as raw audio and silently drops it, unacked,
        # before ever reaching JSON decoding -- audio must never be
        # mistakable for an event frame there. Passing `text=True` tells
        # websockets this bytes payload is already UTF-8 JSON and should go
        # out as a *text* frame instead, matching the sidecar's own
        # `encodeEvent()` (which sends a JS string, i.e. also a text frame).
        #
        # Both of these were verified against a REAL `node dist/index.js`
        # subprocess while building this task's crash-recovery test --
        # without either fix, every event sent through a real (non-fake)
        # sidecar was silently discarded and never acked. Neither the
        # sidecar's own in-process tests (agent-runtime/test/integration/
        # recovery.test.ts drives it with a raw `ws` client sending a JS
        # string, never this bridge) nor this bridge's own tests (the
        # local, in-repo FakeSidecarServer in tests/conftest.py, which
        # `msgspec.json.decode()`s whatever it's given regardless of the
        # old envelope shape or binary/text framing) ever exercised this
        # exact cross-language pairing, so this never surfaced until now.
        async with self._send_lock:
            await connection.send(encode_event(event), text=True)

    async def _send_ack(self, connection: ClientConnection, sequence: int) -> None:
        async with self._send_lock:
            await connection.send(msgspec.json.encode({"kind": "ack", "sequence": sequence}), text=True)

    async def _resend_pending(self, connection: ClientConnection) -> None:
        for event in list(self._pending_acks.values()):
            await self._transmit(connection, event)

    def _remember_pending(self, event: RealtimeEvent) -> None:
        self._pending_acks[event.sequence] = event
        self._pending_acks.move_to_end(event.sequence)
        while len(self._pending_acks) > self._capacity:
            dropped_sequence, _ = self._pending_acks.popitem(last=False)
            logger.warning(
                f"sidecar bridge dropping unacked durable event sequence={dropped_sequence} "
                "(pending-ack capacity exceeded)"
            )

    # -- receiver -----------------------------------------------------------

    async def _run_receiver(self) -> None:
        backoff = _RECONNECT_INITIAL_BACKOFF_SECONDS
        while not self._closed:
            try:
                async with ws_connect(self._url, max_size=_MAX_WIRE_FRAME_BYTES) as connection:
                    self._connection = connection
                    self._connection_ready.set()
                    backoff = _RECONNECT_INITIAL_BACKOFF_SECONDS
                    await self._resend_pending(connection)
                    async for raw in connection:
                        await self._handle_wire_message(connection, raw)
            except asyncio.CancelledError:
                raise
            except (OSError, ConnectionClosed, TimeoutError) as exc:
                logger.debug(f"sidecar bridge connection unavailable: {exc!r}")
            except Exception:
                logger.exception("sidecar bridge receiver hit an unexpected error")
            finally:
                self._connection_ready.clear()
                self._connection = None

            if self._closed:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _RECONNECT_MAX_BACKOFF_SECONDS)

    async def _handle_wire_message(self, connection: ClientConnection, raw: str | bytes) -> None:
        """Dispatches one inbound wire frame: either the small `{"kind":
        "ack", "sequence": ...}` control frame (see `_send_ack`), or a bare
        `RealtimeEvent` -- no envelope -- the sidecar pushes to us (matching
        RuntimeWebSocketServer's own outbound shape, `encodeEvent()`; see
        `_transmit`'s docstring for why there is no `{"kind": "event", ...}`
        wrapper here). A `"kind"` field is exactly how the two are told
        apart: it is never present on a RealtimeEvent (see
        app/realtime/events.py's struct definition).
        """
        try:
            decoded = msgspec.json.decode(raw)
        except msgspec.DecodeError:
            logger.warning("sidecar bridge received a malformed frame; dropping")
            return

        if isinstance(decoded, dict) and decoded.get("kind") == "ack":
            sequence = decoded.get("sequence")
            if isinstance(sequence, int):
                self._pending_acks.pop(sequence, None)
            return

        try:
            event = msgspec.convert(decoded, type=RealtimeEvent)
        except (msgspec.ValidationError, TypeError):
            logger.warning("sidecar bridge received a malformed event; dropping")
            return
        await self._handle_inbound_event(connection, event)

    async def _handle_inbound_event(self, connection: ClientConnection, event: RealtimeEvent) -> None:
        if event.sequence not in self._seen_inbound_sequences:
            self._remember_seen(event.sequence)
            self._fanout(event)

        with contextlib.suppress(OSError, ConnectionClosed):
            await self._send_ack(connection, event.sequence)

    def _remember_seen(self, sequence: int) -> None:
        self._seen_inbound_sequences[sequence] = None
        self._seen_inbound_sequences.move_to_end(sequence)
        while len(self._seen_inbound_sequences) > self._capacity:
            self._seen_inbound_sequences.popitem(last=False)

    def _fanout(self, event: RealtimeEvent) -> None:
        for subscriber in list(self._subscribers):
            try:
                subscriber.put_nowait(event)
            except asyncio.QueueFull:
                # Slow/absent subscriber: drop the oldest buffered event
                # rather than let this grow unboundedly or block the
                # receiver task.
                with contextlib.suppress(asyncio.QueueEmpty):
                    subscriber.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    subscriber.put_nowait(event)
