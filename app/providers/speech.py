"""TTS provider selection for the realtime media plane."""

from __future__ import annotations

from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language

from app.config import Settings
from app.edge_tts_services import EDGE_TTS_DEFAULT_VOICE, build_edge_tts
from app.local_services import build_local_tts
from app.minimax_tts_services import build_minimax_tts
from app.mlx_services import build_mlx_tts
from app.model_adapters import omlx_config_model_type
from app.model_providers import CARTESIA_DEFAULT_MODEL, CloudProviderConfig, load_model_providers
from app.model_settings import load_model_settings, values_for
from app.openrouter_services import build_openrouter_tts
from app.voxcpm_tts_services import VOXCPM2_CUDA_PROVIDER, build_voxcpm2_cuda_tts

from .transcription import _uses_omlx, select_engine


CARTESIA_DEFAULT_VOICE = "47c38ca4-5f35-497b-b1a3-415245fb35e1"
CARTESIA_DEFAULT_LANGUAGE = Language.EN
_OPENROUTER_TTS_DEFAULT_VOICE = {"microsoft/mai-voice-2": "en-US-Harper:MAI-Voice-2"}


def tts_provider_name(settings: Settings) -> str:
    engine = select_engine(settings)
    if engine == "offline":
        return "local"
    if _uses_omlx(settings):
        return "omlx"
    return load_model_providers().cloud.speech.provider or "minimax"


def _require(value: str, env_name: str, provider: str) -> None:
    if not value:
        raise RuntimeError(f"Cloud speech provider '{provider}' requires {env_name}.")


def _openrouter_model_or_first(settings: Settings, configured: str | None) -> str:
    if configured:
        return configured
    if settings.openrouter_tts_models:
        return settings.openrouter_tts_models[0]
    raise RuntimeError("Cloud speech provider 'openrouter' has no configured model.")


def _build_cloud_tts(settings: Settings, cloud: CloudProviderConfig) -> TTSService:
    provider = cloud.speech.provider or "minimax"
    values = values_for("cloud:speech", load_model_settings())
    voice = values.get("voice")
    speed = values.get("speed")
    instructions = values.get("instructions_template")

    if provider == "minimax":
        _require(settings.minimax_api_key, "MINIMAX_API_KEY", provider)
        return build_minimax_tts(
            settings,
            model=cloud.speech.model,
            voice=voice,
            speed=speed,
        )
    if provider == "edge_tts":
        return build_edge_tts(default_voice=voice or EDGE_TTS_DEFAULT_VOICE)
    if provider == VOXCPM2_CUDA_PROVIDER:
        if not settings.voxcpm2_cuda_base_url:
            raise RuntimeError("Cloud speech provider 'VoxCPM2-CUDA' requires VOXCPM2_CUDA_BASE_URL.")
        return build_voxcpm2_cuda_tts(settings, voice_design=settings.voxcpm2_cuda_voice_design)
    if provider == "openrouter":
        _require(settings.openrouter_api_key, "OPENROUTER_API_KEY", provider)
        model = _openrouter_model_or_first(settings, cloud.speech.model)
        resolved_voice = voice or _OPENROUTER_TTS_DEFAULT_VOICE.get(model)
        if not resolved_voice:
            raise RuntimeError("Cloud speech provider 'openrouter' requires a configured voice.")
        return build_openrouter_tts(
            settings,
            model=model,
            voice=resolved_voice,
            default_instructions=instructions,
            speed=speed,
            temperature=values.get("temperature"),
            top_p=values.get("top_p"),
        )

    _require(settings.cartesia_api_key, "CARTESIA_API_KEY", provider)
    overrides: dict[str, float] = {}
    if speed is not None:
        overrides["speed"] = speed
    return CartesiaTTSService(
        api_key=settings.cartesia_api_key,
        settings=CartesiaTTSService.Settings(
            model=cloud.speech.model or CARTESIA_DEFAULT_MODEL,
            voice=voice or CARTESIA_DEFAULT_VOICE,
            language=CARTESIA_DEFAULT_LANGUAGE,
            **overrides,
        ),
    )


def build_tts(settings: Settings) -> TTSService:
    """Build the configured TTS provider with a static default voice locale."""
    engine = select_engine(settings)
    if engine == "offline":
        return build_local_tts(settings)
    if _uses_omlx(settings):
        model_type = omlx_config_model_type(settings, settings.omlx_tts_model)
        values = values_for(f"omlx:{model_type}", load_model_settings()) if model_type else {}
        return build_mlx_tts(
            settings,
            voice=values.get("voice"),
            default_instructions=values.get("instructions"),
            speed=values.get("speed"),
            temperature=values.get("temperature"),
            top_p=values.get("top_p"),
            top_k=values.get("top_k"),
            repetition_penalty=values.get("repetition_penalty"),
        )
    return _build_cloud_tts(settings, load_model_providers().cloud)
