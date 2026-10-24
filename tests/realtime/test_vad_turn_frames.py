import asyncio
import os
from unittest.mock import Mock, patch

from pipecat.frames.frames import (
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.tests.utils import SleepFrame, run_test

from app.config import load_settings
from app.realtime.audio_gate import VadTurnFramesProcessor
from app.realtime.media_pipeline import build_media_pipeline


class _Passthrough(FrameProcessor):
    async def process_frame(self, frame, direction) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


def test_vad_boundaries_are_announced_as_user_turn_frames() -> None:
    down, _up = asyncio.run(
        run_test(
            VadTurnFramesProcessor(),
            frames_to_send=[
                VADUserStartedSpeakingFrame(),
                SleepFrame(0.02),
                VADUserStoppedSpeakingFrame(),
            ],
        )
    )

    assert [type(f) for f in down] == [
        VADUserStartedSpeakingFrame,
        UserStartedSpeakingFrame,
        VADUserStoppedSpeakingFrame,
        UserStoppedSpeakingFrame,
    ]


def test_auto_mode_wires_the_bridge_right_after_the_vad_processor() -> None:
    # Regression: in auto mode nothing produced UserStartedSpeakingFrame, so
    # barge-in (and the voice.user.* events) never fired.
    with (
        patch.dict(os.environ, {"TURN_MODE": "auto"}),
        patch("app.realtime.media_pipeline.SmallWebRTCTransport", return_value=Mock()),
        patch("app.realtime.media_pipeline.build_stt", return_value=_Passthrough()),
        patch("app.realtime.media_pipeline.build_tts", return_value=_Passthrough()),
    ):
        pipeline, _resources = build_media_pipeline(object(), load_settings(), Mock())

    names = [type(p).__name__ for p in pipeline.processors]
    vad = names.index("VADProcessor")
    assert names[vad + 1] == "VadTurnFramesProcessor"
