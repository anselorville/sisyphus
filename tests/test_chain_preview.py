"""Tests for chain preview functionality (app/model_lab_preview.py and app/server.py).

This module tests the full STT→LLM→TTS chain preview, including:
- Audio stashing/retrieval mechanism
- Error handling for empty STT output
- HTTP endpoint integration
"""

import dataclasses
import io
import json
import secrets
import unittest
import wave
from unittest.mock import AsyncMock, patch, MagicMock

from fastapi.testclient import TestClient

from app.config import load_settings
from app.server import (
    app,
    _chain_audio_stash,
    _pop_chain_audio,
    _stash_chain_audio,
)
from app.model_lab_preview import PreviewError, preview_chain


def _make_silent_wav(sample_rate: int = 16000, duration_ms: int = 100) -> bytes:
    """Create a silent 16-bit PCM WAV file for testing."""
    num_channels = 1
    sample_width = 2
    num_frames = (sample_rate * duration_ms) // 1000
    silence = b'\x00' * (num_frames * num_channels * sample_width)

    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav_file:
        wav_file.setnchannels(num_channels)
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(silence)
    return buf.getvalue()


class ChainAudioStashTests(unittest.TestCase):
    """Test the one-shot audio stash helpers."""

    def setUp(self) -> None:
        """Clear the stash before each test."""
        _chain_audio_stash.clear()

    def tearDown(self) -> None:
        """Clear the stash after each test."""
        _chain_audio_stash.clear()

    def test_stash_and_pop_roundtrip(self) -> None:
        """Stash bytes, pop them back, verify they match."""
        test_data = b"test audio data"
        token = _stash_chain_audio(test_data)
        self.assertIsInstance(token, str)
        self.assertGreater(len(token), 0)

        retrieved = _pop_chain_audio(token)
        self.assertEqual(retrieved, test_data)

    def test_pop_unknown_token_returns_none(self) -> None:
        """Popping an unknown token returns None."""
        result = _pop_chain_audio("unknown-token")
        self.assertIsNone(result)

    def test_pop_deletes_entry(self) -> None:
        """Second pop of same token returns None (one-shot behavior)."""
        test_data = b"test audio"
        token = _stash_chain_audio(test_data)
        first_pop = _pop_chain_audio(token)
        self.assertEqual(first_pop, test_data)

        second_pop = _pop_chain_audio(token)
        self.assertIsNone(second_pop)

    def test_stash_evicts_oldest_at_capacity(self) -> None:
        """Stashing beyond 8 entries evicts the oldest."""
        tokens = []
        for i in range(10):
            token = _stash_chain_audio(f"data_{i}".encode())
            tokens.append(token)

        # First two should be evicted (FIFO), only last 8 remain.
        self.assertIsNone(_pop_chain_audio(tokens[0]))
        self.assertIsNone(_pop_chain_audio(tokens[1]))

        # Remaining 8 should all be present.
        for token in tokens[2:]:
            data = _pop_chain_audio(token)
            self.assertIsNotNone(data)


class ChainPreviewErrorHandlingTests(unittest.TestCase):
    """Test error handling in preview_chain for empty/invalid outputs."""

    def setUp(self) -> None:
        """Set up test fixtures.

        Derived from `load_settings()` (env-driven, always fully populated
        with safe empty-string/list defaults -- never raises) rather than
        constructing `Settings(...)` field-by-field: the latter breaks every
        time a field is added to the dataclass (it has, repeatedly) with an
        error pointing at this file instead of at the real change. Only the
        fields this test actually cares about are overridden.
        """
        self.test_settings = dataclasses.replace(
            load_settings(),
            anthropic_api_key="test-key",
            deepgram_api_key="test-key",
            assemblyai_api_key="test-key",
            cartesia_api_key="test-key",
            deepseek_api_key="test-key",
            minimax_api_key="test-key",
            webrtc_host="localhost",
            webrtc_port=8080,
            engine="cloud",
            turn_mode="manual",
        )
        self.silent_wav = _make_silent_wav()

    def test_chain_preview_is_unavailable_for_stt_requests(self) -> None:
        with self.assertRaises(PreviewError) as cm:
            import asyncio
            asyncio.run(preview_chain(
                stt_adapter_id="cloud:transcription",
                llm_adapter_id="cloud:text",
                tts_adapter_id="cloud:speech",
                values={},
                audio_wav_bytes=self.silent_wav,
                settings=self.test_settings,
            ))
        self.assertIn("Chain previews are unavailable", str(cm.exception))

    def test_chain_preview_is_unavailable_for_llm_requests(self) -> None:
        with self.assertRaises(PreviewError) as cm:
            import asyncio
            asyncio.run(preview_chain(
                stt_adapter_id="cloud:transcription",
                llm_adapter_id="cloud:text",
                tts_adapter_id="cloud:speech",
                values={},
                audio_wav_bytes=self.silent_wav,
                settings=self.test_settings,
            ))
        self.assertIn("Chain previews are unavailable", str(cm.exception))


class ChainPreviewEndpointTests(unittest.TestCase):
    """Test the HTTP endpoints for chain preview."""

    def setUp(self) -> None:
        """Set up test client and clear stash."""
        self.client = TestClient(app)
        _chain_audio_stash.clear()

    def tearDown(self) -> None:
        """Clear stash after each test."""
        _chain_audio_stash.clear()

    def test_post_chain_preview_invalid_json_values(self) -> None:
        """POST with invalid JSON in 'values' form field should return 400."""
        silent_wav = _make_silent_wav()
        response = self.client.post(
            "/api/model-lab/preview/chain",
            data={
                "stt_adapter_id": "cloud:transcription",
                "llm_adapter_id": "cloud:text",
                "tts_adapter_id": "cloud:speech",
                "values": "not valid json {",  # Invalid JSON
            },
            files={"audio": ("test.wav", silent_wav, "audio/wav")},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("not valid JSON", response.json()["detail"])

    def test_get_chain_audio_unknown_token_returns_404(self) -> None:
        """GET with unknown token should return 404."""
        response = self.client.get("/api/model-lab/preview/chain/audio/unknown-token-12345")
        self.assertEqual(response.status_code, 404)
        self.assertIn("not found", response.json()["detail"].lower())

    def test_get_chain_audio_token_one_shot(self) -> None:
        """GET /api/model-lab/preview/chain/audio/{token} should delete the token."""
        test_audio = _make_silent_wav()
        token = _stash_chain_audio(test_audio)

        # First fetch should succeed.
        response = self.client.get(f"/api/model-lab/preview/chain/audio/{token}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")
        self.assertEqual(response.content, test_audio)

        # Second fetch with same token should return 404 (one-shot).
        response = self.client.get(f"/api/model-lab/preview/chain/audio/{token}")
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
