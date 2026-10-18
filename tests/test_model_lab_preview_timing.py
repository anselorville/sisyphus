"""Tests for model lab preview timing helpers.

This module tests the `_audio_duration_ms` helper function that calculates
the duration of WAV audio files for latency reporting in preview responses.
"""

import io
import unittest
import wave

from app.model_lab_preview import _audio_duration_ms, PreviewError


class AudioDurationMsTests(unittest.TestCase):
    """Test the _audio_duration_ms helper for calculating WAV duration."""

    def _create_wav(self, sample_rate: int, num_channels: int, nframes: int) -> bytes:
        """Create a synthetic WAV file in memory.

        Args:
            sample_rate: Sample rate in Hz (e.g., 24000).
            num_channels: Number of audio channels (1 for mono, 2 for stereo).
            nframes: Number of frames (samples per channel).

        Returns:
            Bytes of a complete WAV file with the specified parameters.
        """
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav_file:
            wav_file.setnchannels(num_channels)
            wav_file.setsampwidth(2)  # 16-bit PCM
            wav_file.setframerate(sample_rate)
            # Write silence (zeros)
            pcm_data = b"\x00\x00" * (nframes * num_channels)
            wav_file.writeframes(pcm_data)
        return buf.getvalue()

    def test_audio_duration_ms_500ms(self) -> None:
        """Test duration calculation for 500ms of audio (24kHz, mono)."""
        # 24000 Hz, 1 channel, 12000 frames = 500ms
        wav_bytes = self._create_wav(sample_rate=24000, num_channels=1, nframes=12000)
        duration_ms = _audio_duration_ms(wav_bytes)
        self.assertEqual(duration_ms, 500, msg="Expected 500ms for 12000 frames at 24kHz")

    def test_audio_duration_ms_1s(self) -> None:
        """Test duration calculation for 1 second of audio (16kHz, mono)."""
        # 16000 Hz, 1 channel, 16000 frames = 1000ms
        wav_bytes = self._create_wav(sample_rate=16000, num_channels=1, nframes=16000)
        duration_ms = _audio_duration_ms(wav_bytes)
        self.assertEqual(duration_ms, 1000, msg="Expected 1000ms for 16000 frames at 16kHz")

    def test_audio_duration_ms_stereo(self) -> None:
        """Test duration calculation with stereo audio (2 channels)."""
        # 48000 Hz, 2 channels, 24000 frames = 500ms (frame count is per channel)
        wav_bytes = self._create_wav(sample_rate=48000, num_channels=2, nframes=24000)
        duration_ms = _audio_duration_ms(wav_bytes)
        self.assertEqual(duration_ms, 500, msg="Expected 500ms for 24000 frames at 48kHz (stereo)")

    def test_audio_duration_ms_short(self) -> None:
        """Test duration calculation for very short audio (100ms)."""
        # 8000 Hz, 1 channel, 800 frames = 100ms
        wav_bytes = self._create_wav(sample_rate=8000, num_channels=1, nframes=800)
        duration_ms = _audio_duration_ms(wav_bytes)
        self.assertEqual(duration_ms, 100, msg="Expected 100ms for 800 frames at 8kHz")

    def test_audio_duration_ms_rounding(self) -> None:
        """Test that fractional milliseconds are rounded correctly."""
        # 44100 Hz, 1 channel, 44100 frames = 1000ms (exact)
        # 44100 Hz, 1 channel, 44099 frames = 999.977ms -> rounds to 1000
        # 44100 Hz, 1 channel, 22050 frames = 500ms (exact)
        wav_bytes = self._create_wav(sample_rate=44100, num_channels=1, nframes=44099)
        duration_ms = _audio_duration_ms(wav_bytes)
        # 44099 / 44100 * 1000 = 999.977... which rounds to 1000
        self.assertEqual(duration_ms, 1000, msg="Expected rounding for fractional ms")


if __name__ == "__main__":
    unittest.main()
