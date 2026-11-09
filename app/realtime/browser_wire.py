"""Which realtime events reach the browser, and in what shape.

The browser client talks to this process over one WebRTC data channel. It
does not need the full ``RealtimeEvent`` envelope (event ids, sequences,
sources): it needs a flat ``{"type": ..., ...}`` message per event it can
render. This module is the single place that decides both questions, for
the two event origins:

- media-plane events published by this process's own processors
  (``browser_message_for_media_event``), and
- events the sidecar sends back over the event bridge
  (``browser_message_for_sidecar_event``).

``voice.speech.enqueue`` is deliberately absent: ``app/server.py`` turns it
into an ``agent.transcript`` message itself, alongside enqueueing the TTS.
"""

from __future__ import annotations

from typing import Any

from .events import RealtimeEvent

#: Events that exist only for the browser. The sidecar's protocol does not
#: define them (agent-runtime/src/protocol/events.ts) and would reject them,
#: so they must never be sent over the event bridge.
BROWSER_ONLY_EVENT_TYPES = frozenset({"voice.agent.started", "voice.agent.stopped"})

_MEDIA_EVENT_TYPES = frozenset(
    {
        "voice.user.started",
        "voice.user.stopped",
        "voice.transcript.partial",
        "voice.speech.cancel",
        *BROWSER_ONLY_EVENT_TYPES,
    }
)

_TASK_EVENT_TYPES = frozenset(
    {
        "task.created",
        "task.assigned",
        "task.progress",
        "task.completed",
        "task.failed",
        "task.cancelled",
    }
)

_ECOLOGY_EVENT_TYPES = frozenset({"ecology.state.changed", "budget.updated"})

# Payload fields lifted to the top level of the browser message, per type.
_LIFTED_FIELDS: dict[str, tuple[str, ...]] = {
    "voice.transcript.partial": ("text",),
    "voice.speech.cancel": ("reason",),
    "task.created": ("goal",),
    "task.assigned": ("role_id",),
    "task.progress": ("text",),
    "task.completed": ("summary",),
    "task.failed": ("reason",),
    "session.topics.updated": ("topics",),
    "ecology.state.changed": ("state",),
    "budget.updated": ("state",),
}


def _message(event: RealtimeEvent) -> dict[str, Any]:
    message: dict[str, Any] = {"type": event.type, "timestamp": event.timestamp}
    if event.type in _TASK_EVENT_TYPES:
        message["task_id"] = event.task_id
    for field in _LIFTED_FIELDS.get(event.type, ()):
        value = event.payload.get(field)
        # Empty strings carry nothing; `topics` may legitimately be an empty list.
        if value is not None and value != "":
            message[field] = value
    return message


def browser_message_for_media_event(event: RealtimeEvent) -> dict[str, Any] | None:
    """Browser message for a media-plane event, or None if the browser doesn't get it."""
    if event.type not in _MEDIA_EVENT_TYPES:
        return None
    return _message(event)


def browser_message_for_sidecar_event(event: RealtimeEvent) -> dict[str, Any] | None:
    """Browser message for an event from the sidecar, or None if the browser doesn't get it."""
    if event.type in _TASK_EVENT_TYPES or event.type == "session.topics.updated":
        return _message(event)
    if event.type in _ECOLOGY_EVENT_TYPES:
        # A band-less ecology update would blank a known-good reading in the UI.
        if not isinstance(event.payload.get("state"), str):
            return None
        return _message(event)
    return None
