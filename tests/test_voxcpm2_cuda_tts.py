import io
import os
import unittest
import wave
from unittest.mock import patch

from app.config import load_settings
from app.model_providers import CAPABILITY_PROVIDERS, VOXCPM2_CUDA_DEFAULT_MODEL, available_models
from app.voxcpm_tts_services import build_voxcpm2_cuda_tts, wav_chunk_to_audio_frame


def make_wav_chunk(
    pcm: bytes = b"\x01\x00\x02\x00\x03\x00\x04\x00",
    *,
    sample_rate: int = 48000,
    channels: int = 1,
) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return buffer.getvalue()


class VoxCPM2CUDATests(unittest.TestCase):
    def test_provider_is_available_for_cloud_speech(self) -> None:
        settings = load_settings()

        self.assertIn("VoxCPM2-CUDA", CAPABILITY_PROVIDERS["speech"])
        self.assertEqual(
            available_models(settings, "speech", "VoxCPM2-CUDA"),
            [VOXCPM2_CUDA_DEFAULT_MODEL],
        )

    def test_settings_load_voxcpm2_cuda_runtime_config(self) -> None:
        with patch.dict(
            os.environ,
            {
                "VOXCPM2_CUDA_BASE_URL": "http://192.168.2.128:8765",
                "VOXCPM2_CUDA_SEED": "123",
                "VOXCPM2_CUDA_CFG_VALUE": "2.5",
                "VOXCPM2_CUDA_INFERENCE_TIMESTEPS": "8",
                "VOXCPM2_CUDA_VOICE_DESIGN": "一位稳定的测试音色",
            },
            clear=False,
        ):
            settings = load_settings()

        self.assertEqual(settings.voxcpm2_cuda_base_url, "http://192.168.2.128:8765")
        self.assertEqual(settings.voxcpm2_cuda_seed, 123)
        self.assertEqual(settings.voxcpm2_cuda_cfg_value, 2.5)
        self.assertEqual(settings.voxcpm2_cuda_inference_timesteps, 8)
        self.assertEqual(settings.voxcpm2_cuda_voice_design, "一位稳定的测试音色")

    def test_settings_default_voxcpm2_cuda_timesteps_can_keep_up_with_realtime(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            settings = load_settings()

        self.assertEqual(settings.voxcpm2_cuda_inference_timesteps, 5)
        self.assertEqual(settings.voxcpm2_cuda_voice_design, "一位沉稳的男性，声音清晰自然，音色稳定")

    def test_builder_uses_default_voice_design_for_stable_voice(self) -> None:
        with patch.dict(
            os.environ,
            {"VOXCPM2_CUDA_VOICE_DESIGN": "一位稳定的测试音色"},
            clear=False,
        ):
            service = build_voxcpm2_cuda_tts(load_settings())

        self.assertEqual(service._voice_design, "一位稳定的测试音色")

    def test_wav_chunk_to_audio_frame_preserves_streaming_pcm_shape(self) -> None:
        pcm = b"\x01\x00\x02\x00\x03\x00\x04\x00"
        frame = wav_chunk_to_audio_frame(make_wav_chunk(pcm))

        self.assertEqual(frame.audio, pcm)
        self.assertEqual(frame.sample_rate, 48000)
        self.assertEqual(frame.num_channels, 1)


if __name__ == "__main__":
    unittest.main()
