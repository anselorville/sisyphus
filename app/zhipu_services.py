"""Zhipu (BigModel) GLM ASR-backed cloud transcription service.

See docs/zhipu/voice-capability-1784645068/ for the capability manifest this
was built from. Zhipu's `/api/paas/v4/audio/transcriptions` endpoint accepts
the same request shape the OpenAI SDK's `audio.transcriptions.create` already
sends -- multipart/form-data with `model`/`file` fields (confirmed against
the documented contract:
`curl --form model=glm-asr-2512 --form file=@example-file`) -- unlike
OpenRouter's ASR endpoint, which is a JSON body with base64-encoded audio
(see app/openrouter_services.py's `OpenRouterSTTService` docstring for that
contrast). This means `pipecat.services.openai.stt.OpenAISTTService` can be
reused with only the same one-method override app/mlx_services.py's
`MlxSTTService` already needed for oMLX, for the same reason: omit the
`language` field for auto-detect instead of `OpenAISTTService`'s own
`Language.EN` default, since this pipeline is genuinely bidirectional.

Two GLM ASR specifics not shared with oMLX/OpenAI:

- `prompt`: GLM ASR accepts a `prompt` field to pre-set the transcription
  scene/context. Set to a fixed bilingual-scene hint here (mirroring
  `ASSEMBLYAI_BILINGUAL_PROMPT` in app/pipeline.py), since this pipeline's
  two configured languages are Chinese/English.
- Audio format: GLM ASR only accepts WAV or MP3. No conversion needed --
  `SegmentedSTTService` (the base of `BaseWhisperSTTService`/
  `OpenAISTTService`) already wraps buffered PCM into a WAV container before
  calling `_transcribe`.

`stream=true` (SSE partial results) is documented but deliberately not used:
the manifest declares this endpoint's `transport.mode` as `"batch"`
(synchronous), and `SegmentedSTTService` only wants one final transcript per
already-VAD-bounded utterance -- the same one-shot-POST shape every other
batch STT service in this codebase (`OpenAISTTService`/`MlxSTTService`/
`OpenRouterSTTService`) already uses.
"""

from __future__ import annotations

from typing import Any

from pipecat.services.openai.stt import OpenAISTTService

from app.config import Settings

# Zhipu/BigModel's OpenAI-compatible base -- the OpenAI SDK appends
# `/audio/transcriptions` itself, matching the documented endpoint
# `https://open.bigmodel.cn/api/paas/v4/audio/transcriptions`.
ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
ZHIPU_ASR_DEFAULT_MODEL = "glm-asr-2512"

# Reused verbatim from app/pipeline.py's ASSEMBLYAI_BILINGUAL_PROMPT so every
# cloud ASR provider gets the same scene hint for this bidirectional zh/en
# pipeline. Kept as its own constant (not imported from pipeline.py) to avoid
# a circular import -- app/pipeline.py imports from this module, not the
# other way around.
ZHIPU_BILINGUAL_PROMPT = (
    "Transcribe Mandarin Chinese and English. The speaker may switch between "
    "Chinese and English within the same conversation."
)


class ZhipuSTTService(OpenAISTTService):
    """`OpenAISTTService` subclass pointed at Zhipu's GLM ASR endpoint.

    Identical override strategy to `app.mlx_services.MlxSTTService`: omits
    the `language` request field unless `language_hint` is explicitly set,
    instead of always sending one (`OpenAISTTService._transcribe` otherwise
    asserts `language is not None` and defaults to `Language.EN`, which would
    silently mistranscribe whichever of this pipeline's two languages wasn't
    forced -- see `MlxSTTService`'s docstring for the live-verified failure
    mode on a structurally identical oMLX endpoint).
    """

    def __init__(self, *, language_hint: str | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._language_hint = language_hint

    async def _transcribe(self, audio: bytes):
        kwargs: dict = {
            "file": ("audio.wav", audio, "audio/wav"),
            "model": self._settings.model,
        }
        if self._language_hint:
            kwargs["language"] = self._language_hint
        if self._settings.prompt is not None:
            kwargs["prompt"] = self._settings.prompt
        if self._settings.temperature is not None:
            kwargs["temperature"] = self._settings.temperature
        return await self._client.audio.transcriptions.create(**kwargs)


def build_zhipu_stt(
    settings: Settings, *, model: str | None = None, language_hint: str | None = None
) -> ZhipuSTTService:
    """Construct the Zhipu GLM ASR STT service."""
    return ZhipuSTTService(
        api_key=settings.zhipu_api_key,
        base_url=ZHIPU_BASE_URL,
        language_hint=language_hint,
        settings=OpenAISTTService.Settings(
            model=model or ZHIPU_ASR_DEFAULT_MODEL,
            prompt=ZHIPU_BILINGUAL_PROMPT,
        ),
    )
