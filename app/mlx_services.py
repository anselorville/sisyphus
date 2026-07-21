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

import base64
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING, Any

from loguru import logger
from openai import AsyncOpenAI, BadRequestError
from pipecat.frames.frames import ErrorFrame, Frame
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.settings import TTSSettings, assert_given
from pipecat.services.tts_service import TTSService
from pipecat.utils.tracing.service_decorators import traced_tts

from app.config import Settings

if TYPE_CHECKING:
    from app.pipeline import TranslationDirectionStripper


def build_mlx_llm(
    settings: Settings,
    system_prompt: str,
    *,
    temperature: float | None = None,
    top_p: float | None = None,
    enable_thinking: bool = False,
) -> OpenAILLMService:
    """Construct the oMLX translation LLM service (generic OpenAI-compatible
    Pipecat LLM service, pointed at the local oMLX server, using the same
    translation-only system prompt as the cloud/offline paths).

    Requires a running oMLX server at `settings.omlx_base_url` with
    `settings.omlx_llm_model` already loaded.

    `chat_template_kwargs: {"enable_thinking": enable_thinking}` controls
    Qwen3.5's chain-of-thought "thinking" mode, defaulting to `False`
    (disabled) for latency: verified live, a single translation took ~51s
    (1598 reasoning tokens for a two-line answer) with thinking enabled,
    vs. well under a second with `enable_thinking=False`. Real-time
    translation cannot afford the former as a default -- but it's now a
    real Model Lab tunable (`omlx:qwen3_5`'s `enable_thinking` field, see
    app/model_adapters/specs/omlx_qwen3_5.json) for a user who explicitly
    wants higher-quality, slower responses sometimes (e.g. while tuning a
    persona/system prompt via the preview loop, not necessarily mid live
    conversation).

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

    `temperature`/`top_p` (from the Model Lab feature -- see
    app/model_settings.py) are forwarded only when given; the constructor's
    own defaults (`NOT_GIVEN`, meaning "omit from the request") apply
    otherwise.
    """
    overrides: dict[str, float] = {}
    if temperature is not None:
        overrides["temperature"] = temperature
    if top_p is not None:
        overrides["top_p"] = top_p
    return OpenAILLMService(
        api_key=settings.omlx_api_key,
        base_url=settings.omlx_base_url,
        settings=OpenAILLMService.Settings(
            model=settings.omlx_llm_model,
            system_instruction=system_prompt,
            extra={"extra_body": {"chat_template_kwargs": {"enable_thinking": enable_thinking}}},
            **overrides,
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

    `language_hint` (optional, constructor-only -- from `Settings.stt.
    language_hint`, the Model Lab feature, see app/model_settings.py): when
    set, forces this exact language on every request instead of omitting
    the field for auto-detect. Off by default (`None`) to preserve today's
    verified-correct bidirectional auto-detect behavior; only meant for
    cases where auto-detect struggles (e.g. very short utterances).
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


def build_mlx_stt(settings: Settings, language_hint: str | None = None) -> MlxSTTService:
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
        language_hint=language_hint,
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

    `tone_source` (optional): a reference to the pipeline's
    `app.pipeline.TranslationDirectionStripper` instance, read synchronously
    in `run_tts()` for its `last_tone` attribute -- the short free-text tone
    hint the translation LLM infers per utterance (see
    `app.pipeline.build_translation_system_prompt`'s Step 4) -- and forwarded
    as the `instructions` field on oMLX's `/v1/audio/speech` request. Same
    "hold a reference to an upstream processor, read its public attribute
    synchronously" pattern as `TranscriptTapProcessor.direction_source` in
    app/pipeline.py; safe for the same reason that pattern is safe there
    (the pipeline processes one utterance at a time, no concurrent in-flight
    translations). Verified live (this session) against the real oMLX
    server: identical input text with vs. without a non-empty `instructions`
    value produces audibly/measurably different output (different WAV
    duration for the same text), confirming the field is load-bearing, not a
    no-op.
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        tone_source: "TranslationDirectionStripper | None" = None,
        default_instructions: str | None = None,
        speed: float | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        top_k: int | None = None,
        repetition_penalty: float | None = None,
        ref_audio_b64: str | None = None,
        ref_text: str | None = None,
        **kwargs,
    ) -> None:
        super().__init__(push_start_frame=True, push_stop_frames=True, **kwargs)
        self._model = model
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        self._tone_source = tone_source
        # Model Lab overrides (app/model_settings.py): `default_instructions`
        # is the static fallback used when there's no live per-utterance tone
        # yet (e.g. the very first utterance of a session); `speed`/
        # `temperature`/`top_p`/`top_k`/`repetition_penalty` are sent on
        # every request when set -- all real fields on oMLX's
        # `AudioSpeechRequest` schema (confirmed live against the running
        # server's /openapi.json). All `None` by default -- identical
        # behavior to before this feature.
        self._default_instructions = default_instructions
        self._speed = speed
        self._temperature = temperature
        self._top_p = top_p
        self._top_k = top_k
        self._repetition_penalty = repetition_penalty
        # Voice cloning via oMLX's ref_audio/ref_text (base64-encoded WAV bytes).
        # When set, these are sent in the request for zero-shot voice cloning,
        # and the `voice` field is omitted (ref_audio and voice are mutually
        # exclusive). Note: oMLX currently has a known server-side bug
        # (`cannot import name 'resample_audio' from 'mlx_audio.utils'`) that
        # 500s every ref_audio request regardless of sample rate -- this code
        # wires the contract correctly and lets the server error propagate.
        self._ref_audio_b64 = ref_audio_b64
        self._ref_text = ref_text

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

        If `self._tone_source` is set, reads its `last_tone` attribute
        (synchronously -- see this class's docstring for why that's safe)
        and forwards it as the `instructions` field, giving oMLX's TTS model
        a free-text style/delivery hint derived from the translation LLM's
        own per-utterance tone inference. Omits the field entirely when
        there's no tone source or no tone has been inferred yet (e.g. the
        very first utterance of a session, before any direction tag has
        been parsed), rather than sending an empty string.

        Also requests `stream=True` (with a short `streaming_interval`) via
        `extra_body` -- oMLX's `AudioSpeechRequest` schema has these two
        fields (confirmed via its live openapi.json), separate from
        `with_streaming_response`/httpx's own response-streaming below
        (which only controls how the *client* reads bytes off the wire, not
        whether the *server* sends them incrementally).

        IMPORTANT, verified live (this session): enabling `stream`/
        `streaming_interval` does NOT reduce time-to-first-byte against this
        oMLX/VoxCPM2 deployment. Direct measurement of raw chunk arrival
        times (bypassing this class, see the orchestrator's
        investigation) showed cases with `stream=true` and
        `streaming_interval` of 0.1/1.0/unset all delivering 100% of the
        audio bytes in a single burst at the very end of generation --
        first-chunk and last-chunk arrival times differed by well under 1%
        of total request duration in every case, for both a short ("Hello
        there.") and a long (~270 character) test utterance. The WAV header
        framing DOES change when `stream=true` (RIFF/data sizes become the
        unknown-length `0xffffffff` sentinel instead of real byte counts --
        harmless here, since `_stream_audio_frames_from_iterator`'s header
        parsing only reads the sample-rate field at bytes 24-28 and
        unconditionally strips the first 44 bytes, never relying on the
        RIFF/data size fields), so the request *is* being honored
        server-side in some way -- but it does not change delivery timing.
        This is consistent with VoxCPM2 being a non-streaming TTS
        architecture (full-sequence generation required before any audio
        frame exists at all), unlike the STT model in this same oMLX
        install (`nemotron-3.5-asr-streaming-0.6b`, whose name itself
        advertises streaming support). The fields are still sent below
        (harmless, and forward-compatible if oMLX ever adds real
        incremental synthesis for this model), but do not expect any
        latency win from them today -- the actual fix for perceived TTS
        latency in this pipeline, if needed, is sentence-level chunking
        upstream (already happening: see the multiple `Generating TTS`
        log lines per LLM turn) rather than anything tunable in this
        request.
        """
        logger.debug(f"{self}: Generating TTS [{text}]")
        voice = assert_given(self._settings.voice)
        # Per-utterance tone (from the translation LLM) wins; falls back to
        # the Model Lab's static `instructions_template` override when no
        # tone has been inferred yet (e.g. the session's first utterance).
        instructions = (self._tone_source.last_tone if self._tone_source else None) or self._default_instructions
        if instructions:
            logger.debug(f"{self}: Using tone instructions [{instructions}]")
        try:
            await self.start_tts_usage_metrics(text)

            extra_kwargs: dict[str, Any] = {}
            if instructions:
                extra_kwargs["instructions"] = instructions
            if self._speed is not None:
                extra_kwargs["speed"] = self._speed
            extra_body: dict[str, Any] = {"stream": True, "streaming_interval": 0.1}
            if self._temperature is not None:
                extra_body["temperature"] = self._temperature
            if self._top_p is not None:
                extra_body["top_p"] = self._top_p
            if self._top_k is not None:
                extra_body["top_k"] = self._top_k
            if self._repetition_penalty is not None:
                extra_body["repetition_penalty"] = self._repetition_penalty
            if self._ref_audio_b64 is not None:
                extra_body["ref_audio"] = self._ref_audio_b64
            if self._ref_text is not None:
                extra_body["ref_text"] = self._ref_text

            # `voice` is a REQUIRED keyword in the openai SDK's speech.create
            # signature (no default -- omitting it is a client-side TypeError,
            # verified against the installed SDK), so it is always sent even
            # when ref_audio/ref_text cloning fields are present. oMLX accepts
            # both together (its AudioSpeechRequest.voice is nullable and our
            # live probes with ref_audio passed request validation); VoxCPM2
            # has only the one stock voice, so the ref fields are what select
            # the cloned timbre.
            async with self._client.audio.speech.with_streaming_response.create(
                input=text,
                model=self._model,
                voice=voice or "default",
                response_format="wav",
                extra_body=extra_body,
                **extra_kwargs,
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


def build_mlx_tts(
    settings: Settings,
    tone_source: "TranslationDirectionStripper | None" = None,
    *,
    voice: str | None = None,
    default_instructions: str | None = None,
    speed: float | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    top_k: int | None = None,
    repetition_penalty: float | None = None,
) -> MlxTTSService:
    """Construct the oMLX TTS service (custom `MlxTTSService`, pointed at
    oMLX's `/v1/audio/speech` endpoint, using the VoxCPM2 model).

    `voice="default"` is used since oMLX/VoxCPM2 has no agreed meaning for
    OpenAI's fixed voice-name list (alloy/ash/.../verse) -- "default"
    selects VoxCPM2's stock voice. When `voice` is set to a non-"default"
    value, this function attempts to resolve it from the voice library
    (app/voice_library.py). If found, the reference audio is base64-encoded
    and passed to `MlxTTSService` for voice cloning. If not found, a warning
    is logged and the stock voice is used as a fallback.

    `model=None, language=None` are passed explicitly (rather than left
    unset) because `TTSSettings` is a store-mode settings object: any field
    not explicitly given defaults to a `NOT_GIVEN` sentinel, and Pipecat's
    own `AIService.start()` logs a validation error for every field still
    `NOT_GIVEN` once the pipeline starts -- its own docs say to "use None
    for unsupported fields" precisely to avoid that noise. Neither field is
    used by `MlxTTSService.run_tts` (the model id comes from this
    function's own `model=` constructor arg instead, and language is
    auto-detected oMLX-side), so `None` is correct, not a placeholder.

    `tone_source` is forwarded to `MlxTTSService` so it can read the
    translation LLM's per-utterance tone hint (see `MlxTTSService`'s
    docstring) and pass it as the `instructions` field. `None` (the
    default) disables this -- callers that don't care about tone (e.g. a
    future caller that just wants oMLX TTS standalone) get the exact same
    behavior as before this feature existed.

    `voice`/`default_instructions`/`speed`/`temperature`/`top_p`/`top_k`/
    `repetition_penalty` (the Model Lab feature -- see app/model_settings.py
    and app/model_adapters/specs/omlx_voxcpm2.json) are Model-Lab overrides,
    all `None`/inert by default. `default_instructions` is the static
    fallback `MlxTTSService.run_tts` uses when no live per-utterance tone
    has been inferred yet.
    """
    ref_audio_b64: str | None = None
    ref_text_value: str | None = None

    if voice and voice != "default":
        from app import voice_library

        try:
            wav_bytes, ref_text = voice_library.load_voice_ref(voice)
            ref_audio_b64 = base64.b64encode(wav_bytes).decode("ascii")
            ref_text_value = ref_text
        except voice_library.VoiceNotFoundError:
            logger.warning(f"Voice '{voice}' not found in library; falling back to default voice.")
            voice = "default"

    return MlxTTSService(
        api_key=settings.omlx_api_key,
        base_url=settings.omlx_base_url,
        model=settings.omlx_tts_model,
        tone_source=tone_source,
        default_instructions=default_instructions,
        speed=speed,
        temperature=temperature,
        top_p=top_p,
        top_k=top_k,
        repetition_penalty=repetition_penalty,
        ref_audio_b64=ref_audio_b64,
        ref_text=ref_text_value,
        settings=TTSSettings(voice=voice or "default", model=None, language=None),
    )
