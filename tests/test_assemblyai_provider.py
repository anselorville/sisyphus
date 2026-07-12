import os
import unittest
from unittest.mock import patch

from app.config import load_settings
from app.model_providers import (
    ASSEMBLYAI_DEFAULT_MODEL,
    CAPABILITY_PROVIDERS,
    CloudCapabilityConfig,
    CloudProviderConfig,
    available_models,
)
from app.pipeline import _build_cloud_transcription_service


class AssemblyAIProviderTests(unittest.TestCase):
    def test_settings_loads_assemblyai_api_key(self) -> None:
        with patch.dict(os.environ, {"ASSEMBLYAI_API_KEY": "assemblyai-test-key"}, clear=False):
            settings = load_settings()

        self.assertEqual(settings.assemblyai_api_key, "assemblyai-test-key")

    def test_assemblyai_is_available_transcription_provider(self) -> None:
        settings = load_settings()

        self.assertIn("assemblyai", CAPABILITY_PROVIDERS["transcription"])
        self.assertEqual(
            available_models(settings, "transcription", "assemblyai"),
            [ASSEMBLYAI_DEFAULT_MODEL],
        )

    def test_builds_assemblyai_stt_service(self) -> None:
        with patch.dict(os.environ, {"ASSEMBLYAI_API_KEY": "assemblyai-test-key"}, clear=False):
            settings = load_settings()

        service = _build_cloud_transcription_service(
            settings,
            {},
            CloudProviderConfig(
                transcription=CloudCapabilityConfig(provider="assemblyai", model=ASSEMBLYAI_DEFAULT_MODEL)
            ),
        )

        self.assertEqual(type(service).__name__, "AssemblyAISTTService")
        self.assertEqual(service._settings.model, ASSEMBLYAI_DEFAULT_MODEL)
        self.assertIsNone(service._settings.language_detection)
        self.assertIn("Chinese and English", service._settings.prompt)


if __name__ == "__main__":
    unittest.main()
