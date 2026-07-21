import unittest
from unittest.mock import patch

from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline

from app.latency import build_latency_observer
from app.pipeline import build_pipeline_worker


class LatencyObserverTests(unittest.IsolatedAsyncioTestCase):
    async def test_builder_registers_all_latency_handlers(self) -> None:
        observer = build_latency_observer()

        self.assertIsInstance(observer, UserBotLatencyObserver)
        for event_name in (
            "on_latency_measured",
            "on_latency_breakdown",
            "on_first_bot_speech_latency",
        ):
            self.assertTrue(observer._event_handlers[event_name].handlers)

    async def test_registered_callbacks_accept_representative_events(self) -> None:
        observer = build_latency_observer()

        await observer._call_event_handler("on_latency_measured", 0.42)
        await observer._call_event_handler("on_first_bot_speech_latency", 0.21)
        await observer._call_event_handler("on_latency_breakdown", {"ttfb": []})

    def test_pipeline_worker_includes_configured_latency_observer(self) -> None:
        sentinel = UserBotLatencyObserver()
        with (
            patch("app.pipeline.build_pipeline", return_value=(Pipeline([]), object())),
            patch("app.pipeline.build_latency_observer", return_value=sentinel),
        ):
            worker = build_pipeline_worker(object(), object())

        self.assertIn(sentinel, worker._observer._observers)


if __name__ == "__main__":
    unittest.main()
