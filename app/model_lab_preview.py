"""Real, one-shot "preview" calls for the Model Lab (see app/server.py's
`/api/model-lab/preview/*` endpoints).

The product owner's most important ask for this feature: tuning must not be
"blind" -- changing a value and hoping. This module builds the REAL
configured service (cloud or oMLX, whichever is actually active for that
capability) with the user's DRAFT (not-yet-saved) override values layered on
top of whatever is already persisted, and runs exactly one real request
against it via Pipecat's own test harness, `pipecat.tests.utils.run_test`.
Nothing here is simulated -- the same builder functions app/pipeline.py uses
to construct the live pipeline are reused verbatim; only the call site (one
`run_test()` round trip instead of a long-lived pipeline) differs.

Verified live (by the orchestrator, this session, in this exact repo) that
this exact `run_test()` pattern works correctly against real Pipecat service
objects for all three capabilities:

    # LLM
    from pipecat.frames.frames import LLMContextFrame, LLMTextFrame
    from pipecat.processors.aggregators.llm_context import LLMContext
    ctx = LLMContext(messages=[{"role": "user", "content": input_text}])
    down, up = await run_test(llm_service, frames_to_send=[LLMContextFrame(context=ctx)])
    output_text = "".join(f.text for f in down if isinstance(f, LLMTextFrame))

    # TTS
    from pipecat.frames.frames import TTSSpeakFrame, TTSAudioRawFrame
    down, up = await run_test(tts_service, frames_to_send=[TTSSpeakFrame(input_text)])
    audio_frames = [f for f in down if isinstance(f, TTSAudioRawFrame)]

    # STT
    from pipecat.frames.frames import (
        VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
        InputAudioRawFrame, TranscriptionFrame,
    )
    frames = (
        [VADUserStartedSpeakingFrame()]
        + [InputAudioRawFrame(audio=chunk, sample_rate=sr, num_channels=1) for chunk in pcm_chunks]
        + [VADUserStoppedSpeakingFrame()]
    )
    down, up = await run_test(stt_service, frames_to_send=frames)
    transcript = next((f.text for f in down if isinstance(f, TranscriptionFrame)), "")

This module wraps that pattern for each capability, dispatching to whichever
real builder applies for `adapter_id` (`cloud:text` -> the currently
configured cloud text provider via `app.pipeline._build_cloud_text_service`;
`omlx:qwen3_5` -> `app.mlx_services.build_mlx_llm`; etc.), so the preview
always exercises the actual service the live pipeline would build, not a
parallel mock.
"""

from __future__ import annotations

import io
import wave
from typing import Any

from pipecat.frames.frames import (
    InputAudioRawFrame,
    LLMContextFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.tests.utils import run_test

from app.config import Settings
from app.mlx_services import build_mlx_llm, build_mlx_stt, build_mlx_tts
from app.model_providers import CloudProviderConfig, load_model_providers
from app.pipeline import (
    _build_cloud_speech_service,
    _build_cloud_text_service,
    _build_cloud_transcription_service,
)


class PreviewError(ValueError):
    """Raised for any preview request that can't be serviced (unknown
    adapter id, oMLX not configured, etc.) -- callers (app/server.py) map
    this to a 400 response."""


def _short_test_system_prompt() -> str:
    """A short, generic system instruction for text/LLM previews -- NOT the
    full translation system prompt (`app.pipeline.build_translation_system_prompt`).

    The whole point of letting a user preview their own `system_prompt_override`
    is to see what THEIR custom persona produces, unconstrained by the
    production translation-only format contract (the `[XX->YY|tone]` tag
    machinery) -- forcing that contract onto an unrelated persona preview
    would make the preview lie about what the persona actually sounds like.
    When no `system_prompt_override` is given in the draft values, this
    generic instruction is used instead, so the preview still does
    *something* sensible (a plain assistant reply) rather than emitting a
    translation-tagged response the user never asked to preview.
    """
    return "You are a helpful assistant. Respond naturally and concisely to the user's message."


async def preview_text(
    *, adapter_id: str, values: dict[str, Any], input_text: str, settings: Settings
) -> str:
    """Run one real LLM call for `adapter_id` with `values` applied as
    overrides on top of the adapter's saved values, returning the model's
    full text output.

    `values.get("system_prompt_override")`, if present and non-empty, is
    used verbatim as the system instruction (see `_short_test_system_prompt`'s
    docstring for why this is NOT the production translation system prompt).
    """
    from app.model_settings import load_model_settings, values_for

    saved = values_for(adapter_id, load_model_settings())
    merged = {**saved, **values}

    override = merged.get("system_prompt_override")
    system_prompt = override.strip() if isinstance(override, str) and override.strip() else _short_test_system_prompt()

    if adapter_id == "cloud:text":
        model_providers = load_model_providers()
        llm_service = _build_cloud_text_service(
            settings,
            system_prompt,
            {adapter_id: merged},
            model_providers.cloud,
        )
    elif adapter_id.startswith("omlx:"):
        if not settings.omlx_base_url or not settings.omlx_api_key:
            raise PreviewError("oMLX is not configured (OMLX_BASE_URL/OMLX_API_KEY).")
        llm_service = build_mlx_llm(
            settings,
            system_prompt,
            temperature=merged.get("temperature"),
            top_p=merged.get("top_p"),
            enable_thinking=bool(merged.get("enable_thinking", False)),
        )
    else:
        raise PreviewError(f"Unknown or unsupported text adapter id: {adapter_id!r}")

    context = LLMContext(messages=[{"role": "user", "content": input_text}])
    down, _up = await run_test(llm_service, frames_to_send=[LLMContextFrame(context=context)])
    return "".join(f.text for f in down if isinstance(f, LLMTextFrame))


def _wav_bytes_from_frames(frames: list[TTSAudioRawFrame]) -> bytes:
    """Concatenate `TTSAudioRawFrame.audio` chunks and wrap them in a real
    WAV header (via Python's `wave` module) using the frames' own
    `sample_rate`/`num_channels`, 16-bit PCM.

    Per the orchestrator's live-verified finding this session: Pipecat
    normalizes both oMLX's WAV-wrapped 48kHz and OpenRouter's headerless
    24kHz raw PCM into `TTSAudioRawFrame` correctly regardless of the
    underlying engine's wire format -- so this single code path is correct
    for every TTS adapter, not just oMLX.
    """
    if not frames:
        raise PreviewError("TTS service produced no audio frames.")
    sample_rate = frames[0].sample_rate
    num_channels = frames[0].num_channels
    pcm = b"".join(f.audio for f in frames)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(num_channels)
        wav_file.setsampwidth(2)  # 16-bit PCM, matches TTSAudioRawFrame's documented format
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return buf.getvalue()


async def preview_speech(
    *, adapter_id: str, values: dict[str, Any], input_text: str, settings: Settings
) -> bytes:
    """Run one real TTS call for `adapter_id` with `values` applied as
    overrides on top of the adapter's saved values, returning a complete WAV
    file's bytes.
    """
    from app.model_settings import load_model_settings, values_for

    saved = values_for(adapter_id, load_model_settings())
    merged = {**saved, **values}

    if adapter_id == "cloud:speech":
        model_providers = load_model_providers()
        # No direction_stripper / tone source for a preview -- the static
        # `instructions_template`/`voice`/`speed` overrides are exactly what
        # a tuning preview should exercise; live per-utterance tone
        # inference is a pipeline-only concept with no meaning outside a
        # running conversation.
        tts_service = _build_cloud_speech_service(settings, None, {adapter_id: merged}, model_providers.cloud)
    elif adapter_id == "omlx:voxcpm2":
        if not settings.omlx_base_url or not settings.omlx_api_key:
            raise PreviewError("oMLX is not configured (OMLX_BASE_URL/OMLX_API_KEY).")
        tts_service = build_mlx_tts(
            settings,
            None,
            voice=merged.get("voice"),
            default_instructions=merged.get("instructions"),
            speed=merged.get("speed"),
            temperature=merged.get("temperature"),
            top_p=merged.get("top_p"),
            top_k=merged.get("top_k"),
            repetition_penalty=merged.get("repetition_penalty"),
        )
    else:
        raise PreviewError(f"Unknown or unsupported speech adapter id: {adapter_id!r}")

    down, _up = await run_test(tts_service, frames_to_send=[TTSSpeakFrame(input_text)])
    audio_frames = [f for f in down if isinstance(f, TTSAudioRawFrame)]
    return _wav_bytes_from_frames(audio_frames)


def _pcm_chunks_from_wav(wav_bytes: bytes, *, chunk_ms: int = 100) -> tuple[list[bytes], int, int]:
    """Split a WAV file's PCM payload into `chunk_ms`-sized chunks, returning
    `(chunks, sample_rate, num_channels)`. Requires 16-bit PCM WAV input --
    this preview endpoint is WAV-only (see `preview_transcription`'s
    docstring).
    """
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        num_channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        if sample_width != 2:
            raise PreviewError(
                f"Uploaded audio must be 16-bit PCM WAV (got sample width {sample_width * 8} bits)."
            )
        frames_per_chunk = max(1, int(sample_rate * chunk_ms / 1000))
        chunks = []
        while True:
            data = wav_file.readframes(frames_per_chunk)
            if not data:
                break
            chunks.append(data)
    return chunks, sample_rate, num_channels


async def preview_transcription(
    *, adapter_id: str, values: dict[str, Any], audio_wav_bytes: bytes, settings: Settings
) -> str:
    """Run one real STT call for `adapter_id` with `values` applied as
    overrides on top of the adapter's saved values, returning the
    transcript text.

    Requires WAV input (16-bit PCM) -- the uploaded file's own sample rate/
    channel count are read directly from its header (via Python's `wave`
    module) and forwarded as-is to `InputAudioRawFrame`, no resampling
    assumption is made.
    """
    from app.model_settings import load_model_settings, values_for

    saved = values_for(adapter_id, load_model_settings())
    merged = {**saved, **values}

    chunks, sample_rate, num_channels = _pcm_chunks_from_wav(audio_wav_bytes)

    if adapter_id == "cloud:transcription":
        model_providers = load_model_providers()
        cloud: CloudProviderConfig = model_providers.cloud
        stt_service = _build_cloud_transcription_service(settings, {adapter_id: merged}, cloud)
    elif adapter_id.startswith("omlx:"):
        if not settings.omlx_base_url or not settings.omlx_api_key:
            raise PreviewError("oMLX is not configured (OMLX_BASE_URL/OMLX_API_KEY).")
        stt_service = build_mlx_stt(settings, language_hint=merged.get("language_hint"))
    else:
        raise PreviewError(f"Unknown or unsupported transcription adapter id: {adapter_id!r}")

    frames = (
        [VADUserStartedSpeakingFrame()]
        + [
            InputAudioRawFrame(audio=chunk, sample_rate=sample_rate, num_channels=num_channels)
            for chunk in chunks
        ]
        + [VADUserStoppedSpeakingFrame()]
    )
    down, _up = await run_test(stt_service, frames_to_send=frames)
    return next((f.text for f in down if isinstance(f, TranscriptionFrame)), "")
