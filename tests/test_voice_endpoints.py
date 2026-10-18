"""Tests for the Voice Library endpoints (app/server.py).

Tests the GET/POST/DELETE endpoints for voice management with multipart
file uploads. Uses unittest.TestCase with temporary directories for isolation.
"""

import io
import os
import tempfile
import unittest
import wave
from pathlib import Path

from app.voice_library import create_voice


def _make_valid_wav_bytes(duration_s: float = 2.0, sample_rate: int = 16000) -> bytes:
    """Create a valid 16-bit PCM WAV file as bytes (silence).

    Args:
        duration_s: Duration in seconds (default 2.0).
        sample_rate: Sample rate in Hz (default 16000).

    Returns:
        WAV file as bytes.
    """
    num_frames = int(duration_s * sample_rate)
    wav_buffer = io.BytesIO()

    with wave.open(wav_buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)  # 16-bit = 2 bytes
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00" * (num_frames * 2))

    return wav_buffer.getvalue()


class APIEndpointTests(unittest.TestCase):
    """Test the FastAPI endpoints for voice management.

    Uses fastapi.testclient.TestClient if available.
    """

    @classmethod
    def setUpClass(cls) -> None:
        """Import TestClient only once, at class setup."""
        try:
            from fastapi.testclient import TestClient

            cls.TestClient = TestClient
            cls.has_testclient = True
        except ImportError:
            cls.has_testclient = False

    def setUp(self) -> None:
        """Set up test client and temporary voice library directory."""
        if not self.has_testclient:
            self.skipTest("FastAPI TestClient not available")

        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        os.environ["VOICE_LIBRARY_DIR"] = str(self.temp_path)

        from app.server import app

        self.client = self.TestClient(app)

    def tearDown(self) -> None:
        """Clean up temporary directory and restore env var."""
        self.temp_dir.cleanup()
        if "VOICE_LIBRARY_DIR" in os.environ:
            del os.environ["VOICE_LIBRARY_DIR"]

    def test_get_voices_empty(self) -> None:
        """GET /api/model-lab/voices on empty library returns empty list."""
        response = self.client.get("/api/model-lab/voices")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("voices", data)
        self.assertEqual(data["voices"], [])

    def test_post_create_voice(self) -> None:
        """POST /api/model-lab/voices creates a new voice (status 201)."""
        wav_bytes = _make_valid_wav_bytes()
        response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Test Voice",
                "ref_text": "Hello, this is a test.",
                "language": "en",
            },
            files={"audio": ("test.wav", wav_bytes, "audio/wav")},
        )
        self.assertEqual(response.status_code, 201)
        voice = response.json()
        self.assertTrue(voice["id"].startswith("Test Voice"))
        self.assertEqual(voice["name"], "Test Voice")
        self.assertEqual(voice["language"], "en")
        self.assertIn("created_at", voice)

    def test_post_create_voice_without_language(self) -> None:
        """POST /api/model-lab/voices with no language field works."""
        wav_bytes = _make_valid_wav_bytes()
        response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Voice No Lang",
                "ref_text": "Test text.",
            },
            files={"audio": ("test.wav", wav_bytes, "audio/wav")},
        )
        self.assertEqual(response.status_code, 201)
        voice = response.json()
        self.assertIsNone(voice["language"])

    def test_post_create_and_get_voices_lists_it(self) -> None:
        """POST creates a voice; GET /api/model-lab/voices lists it."""
        wav_bytes = _make_valid_wav_bytes()
        post_response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "My Voice",
                "ref_text": "Reference text.",
                "language": "zh",
            },
            files={"audio": ("test.wav", wav_bytes, "audio/wav")},
        )
        self.assertEqual(post_response.status_code, 201)
        created_voice = post_response.json()

        get_response = self.client.get("/api/model-lab/voices")
        self.assertEqual(get_response.status_code, 200)
        data = get_response.json()
        voices = data["voices"]
        self.assertEqual(len(voices), 1)
        self.assertEqual(voices[0]["id"], created_voice["id"])
        self.assertEqual(voices[0]["name"], "My Voice")
        self.assertEqual(voices[0]["language"], "zh")

    def test_post_bad_audio_returns_400(self) -> None:
        """POST with invalid WAV (random bytes) returns 400."""
        bad_audio = b"not a wav file, just garbage"
        response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Bad Audio",
                "ref_text": "Test text.",
            },
            files={"audio": ("bad.wav", bad_audio, "audio/wav")},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("detail", response.json())

    def test_post_empty_audio_returns_400(self) -> None:
        """POST with empty audio bytes returns 400."""
        response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Empty Audio",
                "ref_text": "Test text.",
            },
            files={"audio": ("empty.wav", b"", "audio/wav")},
        )
        self.assertEqual(response.status_code, 400)

    def test_post_audio_too_short_returns_400(self) -> None:
        """POST with audio < 1 second returns 400."""
        wav_bytes = _make_valid_wav_bytes(duration_s=0.5)
        response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Short Audio",
                "ref_text": "Test text.",
            },
            files={"audio": ("short.wav", wav_bytes, "audio/wav")},
        )
        self.assertEqual(response.status_code, 400)

    def test_post_audio_too_long_returns_400(self) -> None:
        """POST with audio > 30 seconds returns 400."""
        wav_bytes = _make_valid_wav_bytes(duration_s=31.0)
        response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Long Audio",
                "ref_text": "Test text.",
            },
            files={"audio": ("long.wav", wav_bytes, "audio/wav")},
        )
        self.assertEqual(response.status_code, 400)

    def test_post_empty_name_returns_400(self) -> None:
        """POST with empty name returns 400."""
        wav_bytes = _make_valid_wav_bytes()
        response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "",
                "ref_text": "Test text.",
            },
            files={"audio": ("test.wav", wav_bytes, "audio/wav")},
        )
        self.assertEqual(response.status_code, 400)

    def test_post_empty_ref_text_returns_400(self) -> None:
        """POST with empty ref_text returns 400."""
        wav_bytes = _make_valid_wav_bytes()
        response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Test Voice",
                "ref_text": "",
            },
            files={"audio": ("test.wav", wav_bytes, "audio/wav")},
        )
        self.assertEqual(response.status_code, 400)

    def test_post_duplicate_name_returns_400(self) -> None:
        """POST with a duplicate name returns 400."""
        wav_bytes1 = _make_valid_wav_bytes()
        wav_bytes2 = _make_valid_wav_bytes()

        response1 = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Duplicate Name",
                "ref_text": "First text.",
            },
            files={"audio": ("test1.wav", wav_bytes1, "audio/wav")},
        )
        self.assertEqual(response1.status_code, 201)

        response2 = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Duplicate Name",
                "ref_text": "Second text.",
            },
            files={"audio": ("test2.wav", wav_bytes2, "audio/wav")},
        )
        self.assertEqual(response2.status_code, 400)
        self.assertIn("already exists", response2.json()["detail"])

    def test_delete_voice_returns_ok(self) -> None:
        """DELETE /api/model-lab/voices/{id} returns {'ok': true}."""
        wav_bytes = _make_valid_wav_bytes()
        post_response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "To Delete",
                "ref_text": "Delete me.",
            },
            files={"audio": ("test.wav", wav_bytes, "audio/wav")},
        )
        voice_id = post_response.json()["id"]

        delete_response = self.client.delete(f"/api/model-lab/voices/{voice_id}")
        self.assertEqual(delete_response.status_code, 200)
        self.assertEqual(delete_response.json(), {"ok": True})

    def test_delete_removes_voice_from_list(self) -> None:
        """After DELETE, the voice is no longer in GET /api/model-lab/voices."""
        wav_bytes = _make_valid_wav_bytes()
        post_response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Disappear",
                "ref_text": "Gone soon.",
            },
            files={"audio": ("test.wav", wav_bytes, "audio/wav")},
        )
        voice_id = post_response.json()["id"]

        self.client.delete(f"/api/model-lab/voices/{voice_id}")

        get_response = self.client.get("/api/model-lab/voices")
        voices = get_response.json()["voices"]
        ids = [v["id"] for v in voices]
        self.assertNotIn(voice_id, ids)

    def test_delete_nonexistent_voice_returns_404(self) -> None:
        """DELETE of nonexistent voice returns 404."""
        response = self.client.delete("/api/model-lab/voices/nonexistent_voice")
        self.assertEqual(response.status_code, 404)

    def test_delete_twice_returns_404_second_time(self) -> None:
        """Second DELETE of same voice returns 404."""
        wav_bytes = _make_valid_wav_bytes()
        post_response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "Delete Twice",
                "ref_text": "Delete once.",
            },
            files={"audio": ("test.wav", wav_bytes, "audio/wav")},
        )
        voice_id = post_response.json()["id"]

        delete1 = self.client.delete(f"/api/model-lab/voices/{voice_id}")
        self.assertEqual(delete1.status_code, 200)

        delete2 = self.client.delete(f"/api/model-lab/voices/{voice_id}")
        self.assertEqual(delete2.status_code, 404)

    def test_voice_id_with_unicode_characters(self) -> None:
        """Voice names with unicode characters are sanitized and work correctly."""
        wav_bytes = _make_valid_wav_bytes()
        response = self.client.post(
            "/api/model-lab/voices",
            data={
                "name": "测试语音",
                "ref_text": "Chinese voice test.",
                "language": "zh",
            },
            files={"audio": ("test.wav", wav_bytes, "audio/wav")},
        )
        self.assertEqual(response.status_code, 201)
        voice = response.json()
        self.assertEqual(voice["name"], "测试语音")

        delete_response = self.client.delete(f"/api/model-lab/voices/{voice['id']}")
        self.assertEqual(delete_response.status_code, 200)

    def test_multiple_voices_listed_in_creation_order(self) -> None:
        """Multiple voices are listed in creation (sorted) order."""
        names = ["Alpha", "Bravo", "Charlie"]
        created_voices = []

        for name in names:
            wav_bytes = _make_valid_wav_bytes()
            response = self.client.post(
                "/api/model-lab/voices",
                data={
                    "name": name,
                    "ref_text": f"Text for {name}.",
                },
                files={"audio": ("test.wav", wav_bytes, "audio/wav")},
            )
            self.assertEqual(response.status_code, 201)
            created_voices.append(response.json())

        get_response = self.client.get("/api/model-lab/voices")
        voices = get_response.json()["voices"]
        self.assertEqual(len(voices), 3)
        for i, name in enumerate(names):
            self.assertEqual(voices[i]["name"], name)


if __name__ == "__main__":
    unittest.main()
