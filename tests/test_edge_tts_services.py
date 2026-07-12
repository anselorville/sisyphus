import unittest

from app.edge_tts_services import EDGE_TTS_DEFAULT_VOICE, build_edge_tts


class EdgeTTSServiceTests(unittest.TestCase):
    def test_build_edge_tts_initializes_complete_tts_settings(self) -> None:
        service = build_edge_tts()

        service._settings.validate_complete()
        self.assertEqual(service._settings.voice, EDGE_TTS_DEFAULT_VOICE)
        self.assertIsNone(service._settings.model)
        self.assertIsNone(service._settings.language)


if __name__ == "__main__":
    unittest.main()
