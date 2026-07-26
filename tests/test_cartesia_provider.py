import os
import unittest
from unittest.mock import patch

import app.providers.speech as speech
from app.config import load_settings
from app.model_providers import CARTESIA_DEFAULT_MODEL, CloudCapabilityConfig, CloudProviderConfig
from app.voxcpm_tts_services import VOXCPM2_CUDA_PROVIDER


RELEASE_CARTESIA_VOICE_ID = "47c38ca4-5f35-497b-b1a3-415245fb35e1"


class CartesiaProviderTests(unittest.TestCase):
    def _settings(self):
        with patch.dict(os.environ, {"CARTESIA_API_KEY": "cartesia-test-key"}, clear=False):
            return load_settings()

    def test_default_cartesia_voice_is_static_for_the_media_plane(self) -> None:
        self.assertEqual(speech.CARTESIA_DEFAULT_VOICE, RELEASE_CARTESIA_VOICE_ID)

    def test_builds_cartesia_tts_service_with_release_voice(self) -> None:
        service = speech._build_cloud_tts(
            self._settings(),
            CloudProviderConfig(
                speech=CloudCapabilityConfig(provider="cartesia", model=CARTESIA_DEFAULT_MODEL)
            ),
        )

        self.assertEqual(type(service).__name__, "CartesiaTTSService")
        self.assertEqual(service._settings.model, CARTESIA_DEFAULT_MODEL)
        self.assertEqual(service._settings.voice, RELEASE_CARTESIA_VOICE_ID)

    def test_voxcpm2_uses_configured_voice_design_not_generic_model_lab_voice(self) -> None:
        settings = self._settings()
        cloud = CloudProviderConfig(
            speech=CloudCapabilityConfig(provider=VOXCPM2_CUDA_PROVIDER, model="streaming")
        )

        with patch.object(speech, "build_voxcpm2_cuda_tts", autospec=True) as build_tts:
            speech._build_cloud_tts(
                settings,
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
