"""Voice-pipeline latency observability.

The observer is deliberately built separately from the WebRTC pipeline so its
logging contract can be tested without provider credentials or a live call.
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver


def build_latency_observer() -> UserBotLatencyObserver:
    """Create a Pipecat observer with stable, searchable latency logs."""
    observer = UserBotLatencyObserver()

    @observer.event_handler("on_latency_measured")
    async def on_latency_measured(
        _observer: UserBotLatencyObserver, latency_seconds: float
    ) -> None:
        logger.info("voice_latency user_to_bot_seconds={:.3f}", latency_seconds)

    @observer.event_handler("on_first_bot_speech_latency")
    async def on_first_bot_speech_latency(
        _observer: UserBotLatencyObserver, latency_seconds: float
    ) -> None:
        logger.info(
            "voice_latency first_bot_speech_seconds={:.3f}", latency_seconds
        )

    @observer.event_handler("on_latency_breakdown")
    async def on_latency_breakdown(
        _observer: UserBotLatencyObserver, breakdown: Any
    ) -> None:
        logger.info("voice_latency breakdown={}", breakdown)

    return observer
