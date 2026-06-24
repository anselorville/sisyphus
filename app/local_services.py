"""Local/offline equivalents of the cloud STT, translation (LLM), and TTS
services used by app/pipeline.py.

These mirror the shape of the cloud service construction in app/pipeline.py
exactly -- same constructor pattern, same role in the pipeline -- so that
`build_pipeline()` can swap between cloud and local services without
changing the pipeline's shape (VAD -> STT -> LLM -> TTS stays identical;
only the concrete service classes differ).

Stack used (see README.md for the operator-facing setup instructions):

- STT: `pipecat.services.whisper.stt.WhisperSTTService`, which wraps
  faster-whisper (CTranslate2) for fully local, CPU-friendly transcription.
  No network access or external process required -- the model is downloaded
  once (from Hugging Face) and cached locally, then loaded directly into
  this process.
- Translation (LLM): `pipecat.services.ollama.llm.OLLamaLLMService`, which
  talks to a locally-running Ollama server over its OpenAI-compatible HTTP
  API. Ollama itself must be installed and running separately, with a small
  instruct model pulled (default: `qwen2.5:1.5b`). This keeps the exact same
  prompt-based translation-only approach as the cloud Anthropic path.
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
`import app.local_services` (and transitively `import app.pipeline`)
succeeds on every platform -- including a Mac dev machine without
`mlx-whisper` installed -- and the local stack only needs to actually be
importable on the platform where it's actually used (the Pi/Linux target,
where this Darwin-only branch never executes).
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from app.config import Settings

if TYPE_CHECKING:
    from pipecat.services.ollama.llm import OLLamaLLMService
    from pipecat.services.piper.tts import PiperTTSService
    from pipecat.services.whisper.stt import WhisperSTTService


def build_local_stt(settings: Settings) -> "WhisperSTTService":
    """Construct the local/offline STT service (faster-whisper via Pipecat's
    WhisperSTTService).

    Language is left unset (auto-detect) to match the cloud Deepgram path's
    behavior in app/pipeline.py, since the translation prompt downstream
    already handles whichever source language shows up.
    """
    from pipecat.services.whisper.stt import WhisperSTTService

    return WhisperSTTService(
        settings=WhisperSTTService.Settings(model=settings.whisper_model),
    )


def build_local_llm(settings: Settings, system_prompt: str) -> "OLLamaLLMService":
    """Construct the local/offline translation LLM service (Ollama via
    Pipecat's OLLamaLLMService, using the same translation-only system
    prompt as the cloud Anthropic path).

    Requires a locally-running Ollama server (default
    http://localhost:11434) with `settings.ollama_model` already pulled.
    """
    from pipecat.services.ollama.llm import OLLamaLLMService, OllamaLLMSettings

    return OLLamaLLMService(
        base_url=settings.ollama_base_url,
        settings=OllamaLLMSettings(
            model=settings.ollama_model,
            system_instruction=system_prompt,
        ),
    )


def build_local_tts(settings: Settings) -> "PiperTTSService":
    """Construct the local/offline TTS service (Piper via Pipecat's
    PiperTTSService).

    Downloads the configured voice model into `settings.piper_download_dir`
    on first use if not already present there.
    """
    from pipecat.services.piper.tts import PiperTTSService

    download_dir = Path(settings.piper_download_dir)
    download_dir.mkdir(parents=True, exist_ok=True)
    return PiperTTSService(
        settings=PiperTTSService.Settings(voice=settings.piper_voice),
        download_dir=download_dir,
    )
