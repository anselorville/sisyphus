"""MiniMax batch transcription of WAV utterances from Pipecat's VAD."""

from collections.abc import AsyncGenerator

import httpx
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.utils.time import time_now_iso8601

MINIMAX_ASR_MODEL = "asr-1.0"


class MiniMaxSTTService(SegmentedSTTService):
    def __init__(self, *, api_key: str, model: str, language_hint: str | None = None):
        super().__init__(settings=STTSettings(model=model, language=None))
        headers = {"Authorization": f"Bearer {api_key}"}
        if language_hint and language_hint.strip():
            headers["language"] = language_hint.strip()
        self._client = httpx.AsyncClient(headers=headers, timeout=30)

    def can_generate_metrics(self) -> bool:
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        await self.start_processing_metrics()
        try:
            response = await self._client.post(
                "https://api.minimax.cn/v1/speech_to_text",
                data={"model": self._settings.model, "response_format": "json"},
                files={"file": ("utterance.wav", audio, "audio/wav")},
            )
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict) or not isinstance(result.get("text"), str):
                raise ValueError("Missing transcription text")
            text = result["text"].strip()
        except (httpx.HTTPError, ValueError) as exc:
            yield ErrorFrame(error=f"MiniMax transcription failed: {exc}")
            return
        finally:
            await self.stop_processing_metrics()
        if text:
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), result=result)

    async def cleanup(self):
        try:
            await super().cleanup()
        finally:
            await self._client.aclose()
