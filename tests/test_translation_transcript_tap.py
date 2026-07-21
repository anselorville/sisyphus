import unittest

from pipecat.frames.frames import (
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.tests.utils import run_test

from pipecat.processors.aggregators.llm_context import LLMContext

from app.pipeline import TranslationTranscriptTapProcessor


class DirectionSource:
    last_direction = "ZH->EN"
    last_tone = "neutral"


class TranslationTranscriptTapProcessorTests(unittest.IsolatedAsyncioTestCase):
    async def test_emits_one_complete_translation_event_for_streamed_llm_chunks(self) -> None:
        processor = TranslationTranscriptTapProcessor(direction_source=DirectionSource())

        down, _up = await run_test(
            processor,
            frames_to_send=[
                LLMFullResponseStartFrame(),
                LLMTextFrame("Excuse"),
                LLMTextFrame(" me, "),
                LLMTextFrame("how do I get there?"),
                LLMFullResponseEndFrame(),
            ],
        )

        messages = [
            frame.message
            for frame in down
            if isinstance(frame, OutputTransportMessageUrgentFrame)
        ]

        self.assertEqual(
            messages,
            [
                {
                    "type": "transcript",
                    "kind": "translation",
                    "text": "Excuse me, how do I get there?",
                    "direction": "ZH->EN",
                    "tone": "neutral",
                }
            ],
        )

    async def test_appends_complete_translation_to_context_when_configured(self) -> None:
        context = LLMContext(messages=[{"role": "user", "content": "请问去地铁站怎么走？"}])
        processor = TranslationTranscriptTapProcessor(
            direction_source=DirectionSource(),
            context=context,
        )

        await run_test(
            processor,
            frames_to_send=[
                LLMFullResponseStartFrame(),
                LLMTextFrame("Excuse"),
                LLMTextFrame(" me, "),
                LLMTextFrame("how do I get to the subway station?"),
                LLMFullResponseEndFrame(),
            ],
        )

        self.assertEqual(
            context.get_messages(),
            [
                {"role": "user", "content": "请问去地铁站怎么走？"},
                {
                    "role": "assistant",
                    "content": "Excuse me, how do I get to the subway station?",
                },
            ],
        )


if __name__ == "__main__":
    unittest.main()
