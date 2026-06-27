"""oMLX-backed equivalents of the cloud/local STT, translation (LLM), and TTS
services used by app/pipeline.py.

These mirror the shape of the cloud/local service construction in
app/pipeline.py and app/local_services.py exactly -- same constructor
pattern, same role in the pipeline -- so that `build_pipeline()` can swap in
the oMLX trio without changing the pipeline's shape (VAD -> STT -> LLM -> TTS
stays identical; only the concrete service classes differ).

**This engine is NOT Pi-portable.** oMLX is built on Apple's MLX framework,
which only runs on Apple Silicon (it has no CPU/Linux/Raspberry Pi backend).
This module exists purely to let you iterate on the product on a Mac dev
machine -- fast local inference, zero cloud API spend, zero network
dependency -- without pretending it is a deployment target. The eventual
Raspberry Pi target is and remains the "offline" engine in
app/local_services.py (faster-whisper + Ollama + Piper). See README.md.

Stack used (a local oMLX server, already running, with three models loaded --
see README.md for setup):

- STT: `MlxSTTService` (this module), a thin subclass of
  `pipecat.services.openai.stt.OpenAISTTService`. oMLX's
  `/v1/audio/transcriptions` endpoint is OpenAI Whisper-API-compatible in
  shape: a REST endpoint that accepts a complete audio file and returns
  `{"text": ...}` -- it is a batch/segment endpoint, not a websocket stream
  (confirmed against oMLX's live OpenAPI spec; despite the loaded model
  being named "nemotron-3.5-asr-streaming-0.6b", oMLX does not expose a
  streaming variant of this endpoint). `OpenAISTTService` extends
  `BaseWhisperSTTService`, which itself extends Pipecat's
  `SegmentedSTTService` -- exactly this "buffer audio until VAD says the
  utterance ended, then POST the whole buffer once" shape -- so the base
  class fits perfectly and no subclass is needed for *that* part. A
  one-method override (`_transcribe`) was needed anyway, for an unrelated
  reason: see `MlxSTTService`'s own docstring -- `OpenAISTTService` always
  sends a fixed `language` field (defaulting to English) with no supported
  way to omit it for auto-detection, which silently breaks transcription of
  non-English audio against oMLX (verified live).
- Translation (LLM): `pipecat.services.openai.llm.OpenAILLMService`, talking
  to oMLX's OpenAI-compatible `/v1/chat/completions` endpoint. This is the
  same generic OpenAI-compatible class Ollama's own Pipecat integration
  (`OLLamaLLMService`) is just a thin wrapper around (see
  app/local_services.py's `build_local_llm`) -- oMLX needs no special
  subclass either, just a different `base_url`/`api_key`/`model`.
- TTS: a custom `MlxTTSService` (this module), talking to oMLX's
  OpenAI-compatible `/v1/audio/speech` endpoint. Like OpenAI's own
  non-realtime TTS endpoint, this is a plain "POST text, get audio back"
  REST call (streamed in chunks), not a websocket -- but unlike OpenAI's
  real API, oMLX always returns a WAV-wrapped response (RIFF header) at
  VoxCPM2's native 48kHz regardless of the requested `response_format`,
  whereas Pipecat's `pipecat.services.openai.tts.OpenAITTSService` hardcodes
  the assumption that `response_format="pcm"` means headerless raw PCM at a
  fixed 24kHz and wraps the response bytes directly as audio with no header
  parsing. That mismatch was verified live (see `MlxTTSService` docstring
  below) and would corrupt playback if `OpenAITTSService` were used as-is.
  `MlxTTSService` is therefore a small subclass of the lower-level
  `pipecat.services.tts_service.TTSService` that makes the same REST call
  but routes the response through `TTSService._stream_audio_frames_from_
  iterator(strip_wav_header=True)` -- an existing Pipecat base-class helper
  built for exactly this "WAV-wrapped HTTP response, unknown sample rate"
  shape -- to strip the header, detect the real source rate, and resample.

The STT and LLM classes require no custom subclass and no streaming
websocket support, so unlike app/local_services.py there is no Darwin/
mlx_whisper-style "must defer the import" concern for them either -- both
live under `pipecat.services.openai`, which has no optional/conditional
native dependencies, and are safe to import unconditionally on every
platform Pipecat supports. `MlxTTSService` (this module) is likewise a
plain subclass of `pipecat.services.tts_service.TTSService` with no
platform-conditional imports.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from loguru import logger
from openai import AsyncOpenAI, BadRequestError
from pipecat.frames.frames import ErrorFrame, Frame
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.settings import TTSSettings, assert_given
from pipecat.services.tts_service import TTSService
from pipecat.utils.tracing.service_decorators import traced_tts

from app.config import Settings


def build_mlx_llm(settings: Settings, system_prompt: str) -> OpenAILLMService:
    """Construct the oMLX translation LLM service (generic OpenAI-compatible
    Pipecat LLM service, pointed at the local oMLX server, using the same
    translation-only system prompt as the cloud/offline paths).

    Requires a running oMLX server at `settings.omlx_base_url` with
    `settings.omlx_llm_model` already loaded.

    `chat_template_kwargs: {"enable_thinking": False}` disables Qwen3.5's
    chain-of-thought "thinking" mode. Verified live: with thinking enabled,
    a single translation took ~51s (1598 reasoning tokens for a two-line
    answer); with `enable_thinking: false`, the same request returned a
    correct translation in well under a second. Real-time translation
    cannot afford the former, so this is not optional.

    This must be nested under `extra={"extra_body": {...}}`, NOT
    `extra={"chat_template_kwargs": {...}}` directly: `Settings.extra` is
    merged as top-level kwargs into the underlying `openai` SDK's
    `chat.completions.create(**params)` call (see
    `BaseOpenAILLMService.get_chat_completions`), and that call only
    accepts kwargs it actually knows about -- `chat_template_kwargs` isn't
    one of them and raises `TypeError: unexpected keyword argument`
    (verified live: every single translation request failed instantly with
    exactly this error until fixed). `extra_body` is the SDK's own
    documented escape hatch for vendor-specific JSON fields like this one --
    its contents are merged into the raw request body without going through
    parameter validation.
    """
    return OpenAILLMService(
        api_key=settings.omlx_api_key,
        base_url=settings.omlx_base_url,
        settings=OpenAILLMService.Settings(
            model=settings.omlx_llm_model,
            system_instruction=system_prompt,
            extra={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
        ),
    )


class MlxSTTService(OpenAISTTService):
    """`OpenAISTTService` subclass that omits the `language` field from the
    oMLX transcription request, instead of always sending one.

    Why this override is necessary: `OpenAISTTService._transcribe` asserts
    `self._settings.language is not None` and always includes a `language`
    key in the request, defaulting to `Language.EN` if none is configured --
    there is no supported way via `Settings`/constructor args to omit the
    field entirely. That default is actively harmful for this pipeline,
    which is genuinely bidirectional (either configured language may be
    spoken in a given utterance -- see
    `app.pipeline.build_translation_system_prompt`); forcing `language=en`
    on every request is wrong half the time.

    Verified live against oMLX's `/v1/audio/transcriptions` with the same
    Chinese test utterance in three configurations:

    - `language` omitted entirely: `{"text": "你好, 请问洗手间在哪里?", ...}`
      -- correct, auto-detected.
    - `language=zh` (correct hint): same correct transcript.
    - `language=en` (`OpenAISTTService`'s own default when unconfigured):
      `{"text": "", ...}` -- empty/silent failure, no error raised.

    So unlike `OpenAILLMService`/`build_mlx_llm` (no override needed) and
    unlike `MlxTTSService` (needed for a *response-shape* mismatch), this
    one-method override exists purely because `OpenAISTTService`'s
    single-fixed-language design doesn't fit a bidirectional pipeline at
    all -- there's no settings knob for "let the model auto-detect."
    """

    async def _transcribe(self, audio: bytes):
        kwargs: dict = {
            "file": ("audio.wav", audio, "audio/wav"),
            "model": self._settings.model,
        }
        if self._settings.prompt is not None:
            kwargs["prompt"] = self._settings.prompt
        if self._settings.temperature is not None:
            kwargs["temperature"] = self._settings.temperature
        return await self._client.audio.transcriptions.create(**kwargs)


def build_mlx_stt(settings: Settings) -> MlxSTTService:
    """Construct the oMLX STT service (`MlxSTTService`, pointed at oMLX's
    `/v1/audio/transcriptions` endpoint).

    See `MlxSTTService` for why a one-method override of
    `pipecat.services.openai.stt.OpenAISTTService` was needed (it has no
    supported way to omit the `language` request field for auto-detect,
    and its own default of `Language.EN` was verified live to silently
    break transcription of non-English audio against oMLX).
    """
    return MlxSTTService(
        api_key=settings.omlx_api_key,
        base_url=settings.omlx_base_url,
        settings=OpenAISTTService.Settings(
            model=settings.omlx_stt_model,
        ),
    )


class MlxTTSService(TTSService):
    """Minimal custom TTS service for oMLX's `/v1/audio/speech` endpoint.

    Why a custom subclass (rather than reusing `pipecat.services.openai.tts.
    OpenAITTSService` as-is): that class is built around OpenAI's own
    real behavior of `response_format="pcm"` -- headerless raw PCM at a
    fixed, well-known 24kHz -- and hardcodes both assumptions (it wraps the
    raw response bytes directly in `TTSAudioRawFrame(chunk, self.sample_rate,
    ...)` with no header parsing). oMLX's `/v1/audio/speech` does NOT behave
    that way: verified live, EVERY `response_format` value (including
    `"pcm"`) returns a complete WAV file (RIFF header intact) sampled at
    VoxCPM2's native 48kHz, not a configurable/24kHz raw stream. Feeding
    OpenAITTSService's raw-PCM assumption oMLX's WAV-wrapped 48kHz bytes
    would corrupt playback (the 44-byte header would be played as noise, and
    the sample rate would be misreported to the rest of the pipeline).

    This class therefore does its own minimal HTTP call (via `AsyncOpenAI`'s
    client, since the request/response shape is otherwise identical to
    OpenAI's) and leans on `TTSService._stream_audio_frames_from_iterator(
    strip_wav_header=True)` -- already part of the Pipecat base class used by
    several other TTS integrations for exactly this "WAV-wrapped HTTP
    response" shape -- to strip the header, auto-detect the real source
    sample rate from it, and resample to the pipeline's target rate. No
    websocket/streaming support is needed: oMLX's endpoint is a one-shot
    REST call per utterance, matching this pipeline's "translate one
    complete utterance, then speak it" shape exactly.
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        **kwargs,
    ) -> None:
        super().__init__(push_start_frame=True, push_stop_frames=True, **kwargs)
        self._model = model
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    def can_generate_metrics(self) -> bool:
        """oMLX TTS supports processing-time metrics."""
        return True

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        """Generate speech for `text` via oMLX's `/v1/audio/speech`.

        Requests `response_format="wav"` explicitly (oMLX returns
        WAV-wrapped audio regardless of the requested format, but asking
        for what we actually get keeps the intent honest) and streams the
        response through `_stream_audio_frames_from_iterator(
        strip_wav_header=True)`, which strips the 44-byte RIFF header,
        detects the real (48kHz) source sample rate from it, and resamples
        to `self.sample_rate`.
        """
        logger.debug(f"{self}: Generating TTS [{text}]")
        voice = assert_given(self._settings.voice)
        try:
            await self.start_tts_usage_metrics(text)

            async with self._client.audio.speech.with_streaming_response.create(
                input=text,
                model=self._model,
                voice=voice or "default",
                response_format="wav",
            ) as r:
                if r.status_code != 200:
                    error = await r.text()
                    logger.error(
                        f"{self} error getting audio (status: {r.status_code}, error: {error})"
                    )
                    yield ErrorFrame(
                        error=f"Error getting audio (status: {r.status_code}, error: {error})"
                    )
                    return

                first_chunk = True
                async for frame in self._stream_audio_frames_from_iterator(
                    r.iter_bytes(self.chunk_size),
                    strip_wav_header=True,
                    context_id=context_id,
                ):
                    if first_chunk:
                        await self.stop_ttfb_metrics()
                        first_chunk = False
                    yield frame
        except BadRequestError as e:
            yield ErrorFrame(error=f"Unknown error occurred: {e}")


def build_mlx_tts(settings: Settings) -> MlxTTSService:
    """Construct the oMLX TTS service (custom `MlxTTSService`, pointed at
    oMLX's `/v1/audio/speech` endpoint, using the VoxCPM2 model).

    `voice="default"` is used since oMLX/VoxCPM2 has no agreed meaning for
    OpenAI's fixed voice-name list (alloy/ash/.../verse) -- "default"
    selects VoxCPM2's stock voice. `ref_audio`/`ref_text` voice cloning is
    supported by oMLX's endpoint but not wired up here; revisit if/when
    voice selection becomes a real requirement (see module docstring).

    `model=None, language=None` are passed explicitly (rather than left
    unset) because `TTSSettings` is a store-mode settings object: any field
    not explicitly given defaults to a `NOT_GIVEN` sentinel, and Pipecat's
    own `AIService.start()` logs a validation error for every field still
    `NOT_GIVEN` once the pipeline starts -- its own docs say to "use None
    for unsupported fields" precisely to avoid that noise. Neither field is
    used by `MlxTTSService.run_tts` (the model id comes from this
    function's own `model=` constructor arg instead, and language is
    auto-detected oMLX-side), so `None` is correct, not a placeholder.
    """
    return MlxTTSService(
        api_key=settings.omlx_api_key,
        base_url=settings.omlx_base_url,
        model=settings.omlx_tts_model,
        settings=TTSSettings(voice="default", model=None, language=None),
    )
