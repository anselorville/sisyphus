"""STT provider selection for the realtime media plane."""

from __future__ import annotations

from pipecat.services.assemblyai.stt import AssemblyAISTTService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.stt_service import STTService
from pipecat.transcriptions.language import Language

from app.config import Settings
from app.connectivity import has_internet_connection
from app.local_services import build_local_stt
from app.mlx_services import build_mlx_stt
from app.model_adapters import omlx_config_model_type
from app.model_providers import (
    ASSEMBLYAI_DEFAULT_MODEL,
    DEEPGRAM_DEFAULT_MODEL,
    CloudProviderConfig,
    load_model_providers,
    model_providers_configured,
)
from app.model_settings import load_model_settings, values_for
from app.openrouter_services import build_stt_from_manifest
from app.zhipu_services import ZHIPU_ASR_DEFAULT_MODEL, build_zhipu_stt


ASSEMBLYAI_BILINGUAL_PROMPT = "Transcribe Mandarin Chinese and English. The speaker may switch between Chinese and English within the same conversation."


def select_engine(settings: Settings) -> str:
    """Resolve the configured speech engine once for a connection."""
    if settings.engine != "auto":
        return settings.engine
    return "cloud" if has_internet_connection() else "offline"


def _uses_omlx(settings: Settings) -> bool:
    providers = load_model_providers()
    return select_engine(settings) == "omlx" or (
        select_engine(settings) == "cloud"
        and model_providers_configured()
        and providers.mode == "local"
    )


def stt_provider_name(settings: Settings) -> str:
    engine = select_engine(settings)
    if engine == "offline":
        return "local"
    if _uses_omlx(settings):
        return "omlx"
    return load_model_providers().cloud.transcription.provider or "zhipu"


def _require(value: str, env_name: str, provider: str) -> None:
    if not value:
        raise RuntimeError(f"Cloud transcription provider '{provider}' requires {env_name}.")


def _openrouter_model_or_first(
    settings: Settings, configured: str | None, capability: str
) -> str:
    if configured:
        return configured
    if settings.openrouter_asr_models:
        return settings.openrouter_asr_models[0]
    raise RuntimeError(
        f"Cloud {capability} provider 'openrouter' has no configured model."
    )


def _build_cloud_stt(settings: Settings, cloud: CloudProviderConfig) -> STTService:
    provider = cloud.transcription.provider or "zhipu"
    values = values_for("cloud:transcription", load_model_settings())
    language_hint = values.get("language_hint")

    if provider == "openrouter":
        _require(settings.openrouter_api_key, "OPENROUTER_API_KEY", provider)
        return build_stt_from_manifest(
            settings,
            model=_openrouter_model_or_first(settings, cloud.transcription.model, "transcription"),
            language_hint=language_hint,
        )
    if provider == "assemblyai":
        _require(settings.assemblyai_api_key, "ASSEMBLYAI_API_KEY", provider)
        return AssemblyAISTTService(
            api_key=settings.assemblyai_api_key,
            settings=AssemblyAISTTService.Settings(
                model=cloud.transcription.model or ASSEMBLYAI_DEFAULT_MODEL,
                language=None,
                language_detection=None,
                prompt=ASSEMBLYAI_BILINGUAL_PROMPT,
                formatted_finals=True,
                continuous_partials=True,
            ),
        )
    if provider == "deepgram":
        _require(settings.deepgram_api_key, "DEEPGRAM_API_KEY", provider)
        stt_settings: dict[str, object] = {
            "model": cloud.transcription.model or DEEPGRAM_DEFAULT_MODEL,
            "punctuate": True,
            "smart_format": True,
            "interim_results": True,
        }
        if language_hint:
            try:
                stt_settings["language"] = Language(language_hint.strip().lower())
            except ValueError:
                pass
        return DeepgramSTTService(
            api_key=settings.deepgram_api_key,
            settings=DeepgramSTTService.Settings(**stt_settings),
        )

    _require(settings.zhipu_api_key, "GLM_API_KEY", provider)
    return build_zhipu_stt(
        settings,
        model=cloud.transcription.model or ZHIPU_ASR_DEFAULT_MODEL,
        language_hint=language_hint,
    )


def build_stt(settings: Settings) -> STTService:
    """Build the configured STT provider without any translation state."""
    engine = select_engine(settings)
    if engine == "offline":
        return build_local_stt(settings)
    if _uses_omlx(settings):
        model_type = omlx_config_model_type(settings, settings.omlx_stt_model)
        values = values_for(f"omlx:{model_type}", load_model_settings()) if model_type else {}
        return build_mlx_stt(settings, language_hint=values.get("language_hint"))
    return _build_cloud_stt(settings, load_model_providers().cloud)
