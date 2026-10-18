"""Tests for the voice library (app/voice_library.py).

Tests cover voice creation, listing, loading, deletion, validation, and
error handling for the voice cloning feature.
"""

import io
import json
import os
import tempfile
import unittest
import wave

from app import voice_library


def _make_wav(duration_s: float, sample_rate: int = 16000) -> bytes:
    """Create a simple 16-bit mono WAV file with the given duration.

    Args:
        duration_s: Duration in seconds
        sample_rate: Sample rate in Hz (default 16000)

    Returns:
        Complete WAV file bytes
    """
    num_frames = int(duration_s * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        silence = b"\x00\x00" * num_frames
        wav_file.writeframes(silence)
    return buf.getvalue()


class VoiceLibraryTests(unittest.TestCase):
    """Test voice library storage, validation, and retrieval."""

    def setUp(self) -> None:
        """Create a temporary directory for the voice library and configure it."""
        self.temp_dir = tempfile.TemporaryDirectory()
        os.environ["VOICE_LIBRARY_DIR"] = self.temp_dir.name

    def tearDown(self) -> None:
        """Clean up the temporary directory and restore env."""
        if "VOICE_LIBRARY_DIR" in os.environ:
            del os.environ["VOICE_LIBRARY_DIR"]
        self.temp_dir.cleanup()

    def test_create_and_list_voice(self) -> None:
        """Test creating a voice and listing it."""
        wav_bytes = _make_wav(5.0)
        result = voice_library.create_voice(
            name="Test Voice",
            ref_text="Hello, this is a test.",
            wav_bytes=wav_bytes,
            language="en",
        )

        self.assertEqual(result["id"], "Test Voice")
        self.assertEqual(result["name"], "Test Voice")
        self.assertEqual(result["language"], "en")
        self.assertIn("created_at", result)

        voices = voice_library.list_voices()
        self.assertEqual(len(voices), 1)
        self.assertEqual(voices[0]["id"], "Test Voice")
        self.assertEqual(voices[0]["name"], "Test Voice")
        self.assertEqual(voices[0]["language"], "en")

    def test_load_voice_ref(self) -> None:
        """Test loading the reference audio and transcript for a voice."""
        wav_bytes = _make_wav(5.0)
        ref_text = "Hello, this is a test."

        voice_library.create_voice(
            name="Load Test",
            ref_text=ref_text,
            wav_bytes=wav_bytes,
            language="en",
        )

        loaded_wav, loaded_text = voice_library.load_voice_ref("Load Test")
        self.assertEqual(loaded_wav, wav_bytes)
        self.assertEqual(loaded_text, ref_text)

    def test_delete_voice(self) -> None:
        """Test deleting a voice from the library."""
        wav_bytes = _make_wav(5.0)
        voice_library.create_voice(
            name="Delete Test",
            ref_text="Hello",
            wav_bytes=wav_bytes,
            language="en",
        )

        voices = voice_library.list_voices()
        self.assertEqual(len(voices), 1)

        voice_library.delete_voice("Delete Test")

        voices = voice_library.list_voices()
        self.assertEqual(len(voices), 0)

    def test_name_sanitization(self) -> None:
        """Test that voice names are properly sanitized into voice IDs."""
        wav_bytes = _make_wav(5.0)

        result = voice_library.create_voice(
            name="  Test / Voice  ",
            ref_text="Hello",
            wav_bytes=wav_bytes,
            language="en",
        )
        self.assertEqual(result["id"], "Test  Voice")

        result = voice_library.create_voice(
            name="梅姨",
            ref_text="你好",
            wav_bytes=wav_bytes,
            language="zh",
        )
        self.assertEqual(result["id"], "梅姨")

    def test_unicode_names_allowed(self) -> None:
        """Test that unicode voice names are allowed."""
        wav_bytes = _make_wav(5.0)
        result = voice_library.create_voice(
            name="温柔女声",
            ref_text="你好",
            wav_bytes=wav_bytes,
            language="zh",
        )
        self.assertEqual(result["id"], "温柔女声")

        voices = voice_library.list_voices()
        self.assertEqual(len(voices), 1)
        self.assertEqual(voices[0]["id"], "温柔女声")

    def test_empty_name_rejected(self) -> None:
        """Test that empty voice names are rejected."""
        wav_bytes = _make_wav(5.0)
        with self.assertRaises(ValueError) as ctx:
            voice_library.create_voice(
                name="",
                ref_text="Hello",
                wav_bytes=wav_bytes,
                language="en",
            )
        self.assertIn("empty", str(ctx.exception).lower())

    def test_whitespace_only_name_rejected(self) -> None:
        """Test that whitespace-only names are rejected."""
        wav_bytes = _make_wav(5.0)
        with self.assertRaises(ValueError) as ctx:
            voice_library.create_voice(
                name="   ",
                ref_text="Hello",
                wav_bytes=wav_bytes,
                language="en",
            )
        self.assertIn("empty", str(ctx.exception).lower())

    def test_name_too_long_rejected(self) -> None:
        """Test that names longer than 40 characters are rejected."""
        wav_bytes = _make_wav(5.0)
        long_name = "a" * 41
        with self.assertRaises(ValueError) as ctx:
            voice_library.create_voice(
                name=long_name,
                ref_text="Hello",
                wav_bytes=wav_bytes,
                language="en",
            )
        self.assertIn("40", str(ctx.exception))

    def test_path_separators_stripped(self) -> None:
        """Test that path separators are removed from voice names."""
        wav_bytes = _make_wav(5.0)
        result = voice_library.create_voice(
            name="Test/Voice\\Name",
            ref_text="Hello",
            wav_bytes=wav_bytes,
            language="en",
        )
        self.assertEqual(result["id"], "TestVoiceName")

    def test_duplicate_voice_rejected(self) -> None:
        """Test that creating a voice with a duplicate ID is rejected."""
        wav_bytes = _make_wav(5.0)
        voice_library.create_voice(
            name="Test Voice",
            ref_text="Hello",
            wav_bytes=wav_bytes,
            language="en",
        )

        with self.assertRaises(voice_library.VoiceExistsError):
            voice_library.create_voice(
                name="Test Voice",
                ref_text="Different text",
                wav_bytes=wav_bytes,
                language="en",
            )

    def test_empty_ref_text_rejected(self) -> None:
        """Test that empty reference text is rejected."""
        wav_bytes = _make_wav(5.0)
        with self.assertRaises(ValueError) as ctx:
            voice_library.create_voice(
                name="Test Voice",
                ref_text="",
                wav_bytes=wav_bytes,
                language="en",
            )
        self.assertIn("empty", str(ctx.exception).lower())

    def test_whitespace_only_ref_text_rejected(self) -> None:
        """Test that whitespace-only reference text is rejected."""
        wav_bytes = _make_wav(5.0)
        with self.assertRaises(ValueError) as ctx:
            voice_library.create_voice(
                name="Test Voice",
                ref_text="   ",
                wav_bytes=wav_bytes,
                language="en",
            )
        self.assertIn("empty", str(ctx.exception).lower())

    def test_non_wav_bytes_rejected(self) -> None:
        """Test that non-WAV bytes are rejected."""
        with self.assertRaises(voice_library.VoiceValidationError) as ctx:
            voice_library.create_voice(
                name="Test Voice",
                ref_text="Hello",
                wav_bytes=b"This is not a WAV file",
                language="en",
            )
        self.assertIn("wav", str(ctx.exception).lower())

    def test_8bit_wav_rejected(self) -> None:
        """Test that 8-bit WAV files are rejected (16-bit PCM required)."""
        num_frames = int(5.0 * 16000)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(1)
            wav_file.setframerate(16000)
            silence = b"\x00" * num_frames
            wav_file.writeframes(silence)
        wav_bytes = buf.getvalue()

        with self.assertRaises(voice_library.VoiceValidationError) as ctx:
            voice_library.create_voice(
                name="Test Voice",
                ref_text="Hello",
                wav_bytes=wav_bytes,
                language="en",
            )
        self.assertIn("16-bit", str(ctx.exception))

    def test_too_short_audio_rejected(self) -> None:
        """Test that audio shorter than 1 second is rejected."""
        wav_bytes = _make_wav(0.5)

        with self.assertRaises(voice_library.VoiceValidationError) as ctx:
            voice_library.create_voice(
                name="Test Voice",
                ref_text="Hi",
                wav_bytes=wav_bytes,
                language="en",
            )
        self.assertIn("1 second", str(ctx.exception))

    def test_too_long_audio_rejected(self) -> None:
        """Test that audio longer than 30 seconds is rejected."""
        wav_bytes = _make_wav(31.0)

        with self.assertRaises(voice_library.VoiceValidationError) as ctx:
            voice_library.create_voice(
                name="Test Voice",
                ref_text="Hello, this is a very long message.",
                wav_bytes=wav_bytes,
                language="en",
            )
        self.assertIn("30 seconds", str(ctx.exception))

    def test_valid_duration_boundaries(self) -> None:
        """Test that durations at the boundaries (1s and 30s) are valid."""
        for duration in [1.0, 30.0]:
            wav_bytes = _make_wav(duration)
            result = voice_library.create_voice(
                name=f"Voice {duration}s",
                ref_text="Hello",
                wav_bytes=wav_bytes,
                language="en",
            )
            self.assertIsNotNone(result["id"])

        voices = voice_library.list_voices()
        self.assertEqual(len(voices), 2)

    def test_load_nonexistent_voice_raises(self) -> None:
        """Test that loading a nonexistent voice raises VoiceNotFoundError."""
        with self.assertRaises(voice_library.VoiceNotFoundError):
            voice_library.load_voice_ref("Nonexistent")

    def test_delete_nonexistent_voice_raises(self) -> None:
        """Test that deleting a nonexistent voice raises VoiceNotFoundError."""
        with self.assertRaises(voice_library.VoiceNotFoundError):
            voice_library.delete_voice("Nonexistent")

    def test_list_voices_sorted_by_created_at(self) -> None:
        """Test that list_voices() returns voices sorted by creation time."""
        wav_bytes = _make_wav(5.0)

        for i in range(3):
            voice_library.create_voice(
                name=f"Voice {i}",
                ref_text=f"Text {i}",
                wav_bytes=wav_bytes,
                language="en",
            )

        voices = voice_library.list_voices()
        self.assertEqual(len(voices), 3)

        created_times = [v["created_at"] for v in voices]
        self.assertEqual(created_times, sorted(created_times))

    def test_corrupt_entry_skipped(self) -> None:
        """Test that list_voices() skips malformed/corrupt entries."""
        wav_bytes = _make_wav(5.0)

        voice_library.create_voice(
            name="Valid Voice",
            ref_text="Hello",
            wav_bytes=wav_bytes,
            language="en",
        )

        root = voice_library._voice_library_root()
        corrupt_dir = root / "corrupt_entry"
        corrupt_dir.mkdir(parents=True, exist_ok=True)
        (corrupt_dir / "ref.wav").write_bytes(wav_bytes)
        (corrupt_dir / "ref.txt").write_text("Hello")

        voices = voice_library.list_voices()
        self.assertEqual(len(voices), 1)
        self.assertEqual(voices[0]["id"], "Valid Voice")

    def test_language_none_allowed(self) -> None:
        """Test that language can be None."""
        wav_bytes = _make_wav(5.0)
        result = voice_library.create_voice(
            name="No Language Voice",
            ref_text="Hello",
            wav_bytes=wav_bytes,
            language=None,
        )

        self.assertIsNone(result["language"])

        voices = voice_library.list_voices()
        self.assertEqual(voices[0]["language"], None)

    def test_meta_json_structure(self) -> None:
        """Test that meta.json is correctly structured."""
        wav_bytes = _make_wav(5.0)
        voice_library.create_voice(
            name="Meta Test",
            ref_text="Hello",
            wav_bytes=wav_bytes,
            language="zh",
        )

        root = voice_library._voice_library_root()
        meta_path = root / "Meta Test" / "meta.json"
        self.assertTrue(meta_path.exists())

        meta = json.loads(meta_path.read_text())
        self.assertEqual(meta["name"], "Meta Test")
        self.assertEqual(meta["language"], "zh")
        self.assertIn("created_at", meta)


class MlxTTSServiceIntegrationTests(unittest.TestCase):
    """Test MlxTTSService with voice cloning parameters."""

    def setUp(self) -> None:
        """Set up test fixtures."""
        self.temp_dir = tempfile.TemporaryDirectory()
        os.environ["VOICE_LIBRARY_DIR"] = self.temp_dir.name

    def tearDown(self) -> None:
        """Clean up."""
        if "VOICE_LIBRARY_DIR" in os.environ:
            del os.environ["VOICE_LIBRARY_DIR"]
        self.temp_dir.cleanup()

    def test_mlx_tts_service_accepts_ref_params(self) -> None:
        """Test that MlxTTSService constructor accepts ref_audio_b64 and ref_text."""
        from app.mlx_services import MlxTTSService

        service = MlxTTSService(
            api_key="test-key",
            base_url="http://localhost:8000",
            model="voxcpm2",
            ref_audio_b64="base64encodeddata",
            ref_text="This is a reference",
        )

        self.assertEqual(service._ref_audio_b64, "base64encodeddata")
        self.assertEqual(service._ref_text, "This is a reference")

    def test_mlx_tts_service_defaults_ref_params_none(self) -> None:
        """Test that MlxTTSService defaults ref params to None."""
        from app.mlx_services import MlxTTSService

        service = MlxTTSService(
            api_key="test-key",
            base_url="http://localhost:8000",
            model="voxcpm2",
        )

        self.assertIsNone(service._ref_audio_b64)
        self.assertIsNone(service._ref_text)


if __name__ == "__main__":
    unittest.main()
