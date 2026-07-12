import os
import unittest
from unittest.mock import patch

from pipecat.transcriptions.language import Language

import app.pipeline as pipeline
from app.config import load_settings
from app.model_providers import CARTESIA_DEFAULT_MODEL, CloudCapabilityConfig, CloudProviderConfig
from app.voxcpm_tts_services import VOXCPM2_CUDA_PROVIDER


RELEASE_CARTESIA_VOICE_ID = "47c38ca4-5f35-497b-b1a3-415245fb35e1"


class CartesiaProviderTests(unittest.TestCase):
    def _settings(self):
        with patch.dict(os.environ, {"CARTESIA_API_KEY": "cartesia-test-key"}, clear=False):
            return load_settings()

    def test_default_cartesia_voice_uses_release_voice_for_supported_languages(self) -> None:
        self.assertEqual(pipeline.cartesia_voice_for_language("English"), RELEASE_CARTESIA_VOICE_ID)
        self.assertEqual(pipeline.cartesia_voice_for_language("Chinese"), RELEASE_CARTESIA_VOICE_ID)

    def test_builds_cartesia_tts_service_with_release_voice(self) -> None:
        service = pipeline._build_cloud_speech_service(
            self._settings(),
            None,
            {},
            CloudProviderConfig(
                speech=CloudCapabilityConfig(provider="cartesia", model=CARTESIA_DEFAULT_MODEL)
            ),
        )

        self.assertEqual(type(service).__name__, "ToneAwareCartesiaTTSService")
        self.assertEqual(service._settings.model, CARTESIA_DEFAULT_MODEL)
        self.assertEqual(service._settings.voice, RELEASE_CARTESIA_VOICE_ID)

    def test_cartesia_language_tracks_translation_direction_destination(self) -> None:
        resolver = getattr(pipeline, "_cartesia_language_for_direction", None)
        if resolver is None:
            self.fail("_cartesia_language_for_direction should resolve dynamic TTS language")

        self.assertEqual(resolver("EN->ZH", Language.EN), Language.ZH)
        self.assertEqual(resolver("ZH->EN", Language.ZH), Language.EN)
        self.assertEqual(resolver(None, Language.EN), Language.EN)

    def test_voxcpm2_uses_configured_voice_design_not_generic_model_lab_voice(self) -> None:
        settings = self._settings()
        cloud = CloudProviderConfig(
            speech=CloudCapabilityConfig(provider=VOXCPM2_CUDA_PROVIDER, model="streaming")
        )

        with patch.object(pipeline, "build_voxcpm2_cuda_tts", autospec=True) as build_tts:
            pipeline._build_cloud_speech_service(
                settings,
                None,
                {"cloud:speech": {"voice": "a-generic-provider-voice-id"}},
                cloud,
            )

        self.assertEqual(build_tts.call_count, 1)
        self.assertIs(build_tts.call_args.args[0], settings)
        self.assertEqual(
            build_tts.call_args.kwargs,
            {"voice_design": settings.voxcpm2_cuda_voice_design},
        )


if __name__ == "__main__":
    unittest.main()
