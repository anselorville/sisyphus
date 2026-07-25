"""Local/offline equivalents of the cloud STT and TTS services used by
app/providers/ (see app/providers/transcription.py and app/providers/speech.py).

These mirror the shape of the cloud service construction in app/providers/
exactly -- same constructor pattern, same role in the media pipeline -- so
that `app.realtime.media_pipeline.build_media_pipeline()` can swap between
cloud and local services without changing the pipeline's shape. The media
pipeline itself is STT -> TTS only (no LLM/reasoning step runs inside
Pipecat -- that lives in the TypeScript agent-runtime sidecar); `build_local_llm`
below is kept as offline-completion infrastructure for callers that need a
standalone local LLM call, but is not currently wired into the media pipeline.

Stack used (see README.md for the operator-facing setup instructions):

- STT: `pipecat.services.whisper.stt.WhisperSTTService`, which wraps
  faster-whisper (CTranslate2) for fully local, CPU-friendly transcription.
  No network access or external process required -- the model is downloaded
  once (from Hugging Face) and cached locally, then loaded directly into
  this process.
- LLM: `pipecat.services.ollama.llm.OLLamaLLMService`, which talks to a
  locally-running Ollama server over its OpenAI-compatible HTTP API. Ollama
  itself must be installed and running separately, with a small instruct
  model pulled (default: `qwen2.5:1.5b`).
- TTS: `pipecat.services.piper.tts.PiperTTSService`, which wraps the Piper
  TTS engine in-process (no separate server needed). The voice model is
  downloaded once and cached locally.

All three are genuinely offline at inference time once their models/servers
are in place -- only first-run model downloads need network access.

Note on import style: the three Pipecat service classes below are imported
*inside* their respective `build_local_*()` functions rather than at module
level. This is deliberate, not just style: `pipecat.services.whisper.stt`
unconditionally attempts `import mlx_whisper` at module-import time on any
Darwin/arm64 host (e.g. an Apple Silicon dev machine), regardless of which
Whisper backend you actually want, and raises ImportError if the optional
`mlx-whisper` extra isn't installed. Deferring the import means
`import app.local_services` (and transitively `import
app.providers.transcription`, which imports this module to build the
offline STT service) succeeds on every platform -- including a Mac dev
machine without `mlx-whisper` installed -- and the local stack only needs
to actually be importable on the platform where it's actually used (the
Pi/Linux target, where this Darwin-only branch never executes).
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from app.config import Settings

if TYPE_CHECKING:
    from pipecat.services.ollama.llm import OLLamaLLMService
    from pipecat.services.piper.tts import PiperTTSService
    from pipecat.services.whisper.stt import WhisperSTTService


def build_local_stt(settings: Settings, language_hint: str | None = None) -> "WhisperSTTService":
    """Construct the local/offline STT service (faster-whisper via Pipecat's
    WhisperSTTService).

    Language is left unset (auto-detect) by default, to match the cloud
    Deepgram path's behavior (see app/providers/transcription.py).
    `language_hint` (from `Settings.stt.language_hint`, the Model Lab
    feature -- see app/model_settings.py) forces a specific language when
    given and recognized; an unrecognized code is ignored rather than
    raising, since this is a best-effort hint, not a required field.
    """
    from pipecat.services.whisper.stt import WhisperSTTService
    from pipecat.transcriptions.language import Language

    language = None
    if language_hint:
        try:
            language = Language(language_hint.strip().lower())
        except ValueError:
            pass

    return WhisperSTTService(
        settings=WhisperSTTService.Settings(model=settings.whisper_model, language=language),
    )


def build_local_llm(
    settings: Settings,
    system_prompt: str,
    *,
    temperature: float | None = None,
    top_p: float | None = None,
) -> "OLLamaLLMService":
    """Construct a local/offline LLM completion service (Ollama via
    Pipecat's OLLamaLLMService) with the given system prompt.

    Requires a locally-running Ollama server (default
    http://localhost:11434) with `settings.ollama_model` already pulled.

    `temperature`/`top_p` (from `Settings.llm`, the Model Lab feature -- see
    app/model_settings.py) are forwarded when given; `OllamaLLMSettings`
    extends `BaseOpenAILLMService.Settings`, which defaults both to a
    NOT_GIVEN sentinel meaning "omit from the request" -- passing `None`
    explicitly here would send a real `null`, so the kwargs are only
    included when an override is actually set.
    """
    from pipecat.services.ollama.llm import OLLamaLLMService, OllamaLLMSettings

    overrides: dict[str, float] = {}
    if temperature is not None:
        overrides["temperature"] = temperature
    if top_p is not None:
        overrides["top_p"] = top_p

    return OLLamaLLMService(
        base_url=settings.ollama_base_url,
        settings=OllamaLLMSettings(
            model=settings.ollama_model,
            system_instruction=system_prompt,
            **overrides,
        ),
    )


def build_local_tts(settings: Settings) -> "PiperTTSService":
    """Construct the local/offline TTS service (Piper via Pipecat's
    PiperTTSService).

    Downloads the configured voice model into `settings.piper_download_dir`
    on first use if not already present there.

    No tone/expressiveness wiring here (unlike `MlxTTSService.run_tts` in
    app/mlx_services.py, which does accept an `instructions` field), and this
    is a deliberate "leave it out" rather than an oversight: checked Pipecat's
    `pipecat.services.piper.tts.PiperTTSService`/`PiperHttpTTSService`
    (both `run_tts` implementations) and Piper's own `PiperVoice.synthesize`
    call -- neither the Pipecat wrapper nor Piper's underlying request/API
    shape (`{"text", "voice"}` for the HTTP server; `synthesize(text)` for
    the in-process binding) exposes any style/emotion/instructions
    parameter at all. Piper is a classical neural TTS model with no
    expressiveness control surface in this library, unlike VoxCPM2's
    `instructions` field (oMLX). This path is also the lowest priority of
    the three per the task's own framing (the Pi-portable fallback, not
    where most live testing happens), so rather than fabricate an
    unverifiable mechanism, the tone hint is simply dropped on this path --
    offline/Piper TTS stays exactly as flat as it was before this feature.
    """
    from pipecat.services.piper.tts import PiperTTSService

    download_dir = Path(settings.piper_download_dir)
    download_dir.mkdir(parents=True, exist_ok=True)
    return PiperTTSService(
        settings=PiperTTSService.Settings(voice=settings.piper_voice),
        download_dir=download_dir,
    )
