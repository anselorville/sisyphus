"""Lightweight internet-connectivity check used to pick cloud vs. local
services at pipeline startup.

This is intentionally simple: a single fast, low-timeout attempt to reach a
well-known, highly-available host. It is not meant to be a robust network
quality probe, and it is only consulted once at startup (see app/pipeline.py)
-- there is no continuous/mid-conversation re-checking or fallback in this
phase. Any failure (DNS, TCP, TLS, timeout, etc.) is treated as "offline"
rather than raising, since the whole point of this check is to decide
gracefully rather than crash the server when there's no network.
"""

from __future__ import annotations

import socket

from loguru import logger

# Cloudflare's public DNS resolver. Chosen because it answers a bare TCP
# connection on port 53 extremely quickly from virtually anywhere, doesn't
# require HTTP/TLS handshake overhead, and is about as close to "is there an
# internet connection" as a single probe gets without depending on any one
# application-layer service being up.
_PROBE_HOST = "1.1.1.1"
_PROBE_PORT = 53
_PROBE_TIMEOUT_SECONDS = 2.0


def has_internet_connection(
    host: str = _PROBE_HOST,
    port: int = _PROBE_PORT,
    timeout: float = _PROBE_TIMEOUT_SECONDS,
) -> bool:
    """Best-effort check for a working internet connection.

    Attempts a raw TCP connection to `host:port` with a short timeout.
    Returns True only if the connection succeeds; any exception (timeout,
    DNS failure, network unreachable, connection refused, etc.) is treated
    as "no connection" and returns False rather than propagating.

    This is a point-in-time check made once at pipeline startup, not a
    continuous monitor -- see app/pipeline.py for how the result is used to
    choose between cloud and local services.
    """
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError as exc:
        logger.debug(f"Connectivity check failed ({host}:{port}): {exc}")
        return False
