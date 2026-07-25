"""Shared pytest fixtures for the realtime/event-bridge test suites.

Only genuinely cross-file infrastructure lives here (the fake sidecar
server); small one-off event-construction helpers stay local to the test
files that use them, matching the existing convention in
tests/realtime/test_queueing.py's `make_event`.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import msgspec
import pytest_asyncio
from websockets.asyncio.server import Server, ServerConnection, serve as ws_serve
from websockets.exceptions import ConnectionClosed

from app.realtime.events import RealtimeEvent

_POLL_INTERVAL_SECONDS = 0.01
_WAIT_TIMEOUT_SECONDS = 5.0


class FakeSidecarServer:
    """A real local WebSocket server standing in for the TypeScript sidecar.

    Records every event it receives (across reconnects -- `received` is
    never reset) and can simulate a sidecar that disappears before acking,
    so tests can drive `SidecarEventBridge`'s reconnect/replay path against
    an actual socket instead of a mock.
    """

    def __init__(self) -> None:
        self.received: list[RealtimeEvent] = []
        self.url: str = ""
        self._server: Server | None = None
        self._connections: list[ServerConnection] = []
        self._suppress_ack = False

    async def start(self) -> None:
        self._server = await ws_serve(self._handle, "127.0.0.1", 0)
        port = self._server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}/events"

    async def _handle(self, connection: ServerConnection) -> None:
        self._connections.append(connection)
        try:
            async for raw in connection:
                envelope = msgspec.json.decode(raw)
                if not isinstance(envelope, dict) or envelope.get("kind") != "event":
                    continue
                event = msgspec.convert(envelope["event"], type=RealtimeEvent)
                self.received.append(event)
                if not self._suppress_ack:
                    await connection.send(msgspec.json.encode({"kind": "ack", "sequence": event.sequence}))
        except ConnectionClosed:
            pass

    async def _wait_until(self, predicate, *, timeout: float = _WAIT_TIMEOUT_SECONDS) -> None:
        async def _poll() -> None:
            while not predicate():
                await asyncio.sleep(_POLL_INTERVAL_SECONDS)

        await asyncio.wait_for(_poll(), timeout=timeout)

    async def disconnect_before_ack(self) -> None:
        """Drop the current connection before it acks anything it has
        received so far, without acking anything already in flight either."""
        self._suppress_ack = True
        await self._wait_until(lambda: len(self.received) >= 1)
        await self._connections[-1].close()

    async def accept_reconnect(self) -> None:
        """Wait for a new connection to arrive and for it to deliver at
        least one more event (the replay)."""
        connections_before = len(self._connections)
        received_before = len(self.received)
        await self._wait_until(lambda: len(self._connections) > connections_before)
        await self._wait_until(lambda: len(self.received) > received_before)

    async def send_event_to_client(self, event: RealtimeEvent) -> None:
        """Push a sidecar-originated (inbound, from the bridge's point of
        view) event down to the currently connected client."""
        await self._wait_until(lambda: len(self._connections) >= 1)
        connection = self._connections[-1]
        await connection.send(msgspec.json.encode({"kind": "event", "event": event}))

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()


@pytest_asyncio.fixture
async def fake_ws_server() -> AsyncIterator[FakeSidecarServer]:
    server = FakeSidecarServer()
    await server.start()
    try:
        yield server
    finally:
        await server.close()
