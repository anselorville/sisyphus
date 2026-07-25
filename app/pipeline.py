"""Compatibility entry points for the realtime media plane."""

from __future__ import annotations

from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection

from app.config import Settings
from app.latency import build_latency_observer
from app.providers import select_engine
from app.realtime.media_pipeline import build_media_pipeline


def build_pipeline(
    webrtc_connection: SmallWebRTCConnection,
    settings: Settings,
    agent_link: object | None = None,
):
    """Compatibility wrapper for callers not yet migrated to media_pipeline."""
    return build_media_pipeline(webrtc_connection, settings, agent_link)


def build_pipeline_worker(
    webrtc_connection: SmallWebRTCConnection,
    settings: Settings,
    agent_link: object | None = None,
) -> PipelineWorker:
    pipeline, _resources = build_pipeline(webrtc_connection, settings, agent_link)
    return PipelineWorker(
        pipeline,
        observers=[build_latency_observer()],
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
    )
