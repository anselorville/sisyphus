"""Persisted voice library for TTS voice cloning.

This module manages a directory of reference audio files (with transcripts)
that can be used to clone voices via oMLX's VoxCPM2 model's ref_audio/ref_text
parameters. Each voice is stored under its own directory with three files:
ref.wav (16-bit PCM audio), ref.txt (transcript), and meta.json (metadata).

Storage root is read from the VOICE_LIBRARY_DIR environment variable at
call time (for test isolation), defaulting to <repo-root>/models/voices.

Voice IDs are sanitized display names: whitespace stripped, path separators
removed, max 40 chars, unicode allowed. Empty names and duplicates are rejected.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import shutil
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class VoiceExistsError(Exception):
    """Raised when attempting to create a voice that already exists."""

    pass


class VoiceNotFoundError(Exception):
    """Raised when attempting to access a voice that does not exist."""

    pass


class VoiceValidationError(Exception):
    """Raised when voice validation fails (format, duration, etc.)."""

    pass


def _voice_library_root() -> Path:
    """Get the voice library root directory, reading from VOICE_LIBRARY_DIR
    environment variable at call time (for test isolation), defaulting to
    <repo-root>/models/voices.
    """
    if env_path := os.environ.get("VOICE_LIBRARY_DIR"):
        return Path(env_path)
    repo_root = Path(__file__).resolve().parent.parent
    return repo_root / "models" / "voices"


def _sanitize_voice_id(name: str) -> str:
    """Sanitize a display name into a voice_id.

    - Strip leading/trailing whitespace
    - Reject empty strings
    - Remove path separators (/ \) and control characters
    - Max 40 characters
    - Allow unicode

    Raises ValueError with a human-readable message if validation fails.
    """
    name = name.strip()
    if not name:
        raise ValueError("Voice name cannot be empty.")
    if len(name) > 40:
        raise ValueError("Voice name must be at most 40 characters.")
    sanitized = re.sub(r"[/\\:\x00-\x1f\x7f]", "", name)
    if not sanitized:
        raise ValueError("Voice name must contain at least one non-separator character.")
    return sanitized


def _validate_wav_bytes(wav_bytes: bytes) -> tuple[int, int]:
    """Validate wav_bytes as 16-bit PCM WAV and return (sample_rate, duration_ms).

    Raises VoiceValidationError with human-readable message if validation fails.
    """
    if not wav_bytes:
        raise VoiceValidationError("WAV file is empty.")
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
            sample_width = wav_file.getsampwidth()
            if sample_width != 2:
                raise VoiceValidationError(
                    f"Audio must be 16-bit PCM WAV (got {sample_width * 8} bits)."
                )
            num_frames = wav_file.getnframes()
            sample_rate = wav_file.getframerate()
            if sample_rate <= 0 or num_frames <= 0:
                raise VoiceValidationError("Invalid WAV format (invalid sample rate or frame count).")
            duration_s = num_frames / sample_rate
            duration_ms = int(duration_s * 1000)
    except wave.Error as e:
        raise VoiceValidationError(f"Failed to parse WAV file: {e}")

    if duration_s < 1.0:
        raise VoiceValidationError(
            f"Audio must be at least 1 second long (got {duration_s:.1f}s)."
        )
    if duration_s > 30.0:
        raise VoiceValidationError(
            f"Audio must be at most 30 seconds long (got {duration_s:.1f}s)."
        )

    return sample_rate, duration_ms


def list_voices() -> list[dict[str, Any]]:
    """List all available voices, sorted by creation time (oldest first).

    Returns a list of dicts with keys: id, name, language, created_at (ISO string).

    Tolerates and skips malformed entries (e.g. directory without meta.json)
    rather than raising an exception.
    """
    root = _voice_library_root()
    if not root.exists():
        return []

    voices: list[dict[str, Any]] = []
    for voice_dir in sorted(root.iterdir()):
        if not voice_dir.is_dir():
            continue
        meta_path = voice_dir / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text())
            voice_id = voice_dir.name
            if isinstance(meta, dict) and "name" in meta and "created_at" in meta:
                voices.append(
                    {
                        "id": voice_id,
                        "name": meta["name"],
                        "language": meta.get("language"),
                        "created_at": meta["created_at"],
                    }
                )
        except (OSError, json.JSONDecodeError):
            pass

    voices.sort(key=lambda v: v["created_at"])
    return voices


def create_voice(
    name: str, ref_text: str, wav_bytes: bytes, language: str | None = None
) -> dict[str, Any]:
    """Create a new voice in the library.

    Args:
        name: Display name (will be sanitized into voice_id)
        ref_text: Transcript of the reference audio
        wav_bytes: 16-bit PCM WAV audio bytes
        language: Optional language code (e.g. "zh", "en")

    Returns:
        Dict with keys: id, name, language, created_at (ISO string)

    Raises:
        ValueError: If name cannot be sanitized (via _sanitize_voice_id)
        VoiceValidationError: If wav_bytes is not valid 16-bit PCM WAV
                              or duration is outside 1-30 seconds
        ValueError: If ref_text is empty
        VoiceExistsError: If a voice with this id already exists
    """
    if not ref_text or not ref_text.strip():
        raise ValueError("Reference text cannot be empty.")

    voice_id = _sanitize_voice_id(name)
    sample_rate, duration_ms = _validate_wav_bytes(wav_bytes)

    root = _voice_library_root()
    voice_dir = root / voice_id
    if voice_dir.exists():
        raise VoiceExistsError(f"Voice '{voice_id}' already exists.")

    voice_dir.mkdir(parents=True, exist_ok=True)

    try:
        (voice_dir / "ref.wav").write_bytes(wav_bytes)
        (voice_dir / "ref.txt").write_text(ref_text)

        created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        meta = {
            "name": name,
            "language": language,
            "created_at": created_at,
        }
        (voice_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")

        return {
            "id": voice_id,
            "name": name,
            "language": language,
            "created_at": created_at,
        }
    except Exception:
        shutil.rmtree(voice_dir, ignore_errors=True)
        raise


def load_voice_ref(voice_id: str) -> tuple[bytes, str]:
    """Load the reference audio and transcript for a voice.

    Args:
        voice_id: The voice identifier

    Returns:
        Tuple of (ref.wav bytes, ref.txt contents)

    Raises:
        VoiceNotFoundError: If the voice does not exist
    """
    root = _voice_library_root()
    voice_dir = root / voice_id
    wav_path = voice_dir / "ref.wav"
    txt_path = voice_dir / "ref.txt"

    if not wav_path.exists() or not txt_path.exists():
        raise VoiceNotFoundError(f"Voice '{voice_id}' not found.")

    wav_bytes = wav_path.read_bytes()
    ref_text = txt_path.read_text()
    return wav_bytes, ref_text


def delete_voice(voice_id: str) -> None:
    """Delete a voice from the library.

    Args:
        voice_id: The voice identifier

    Raises:
        VoiceNotFoundError: If the voice does not exist
    """
    root = _voice_library_root()
    voice_dir = root / voice_id

    if not voice_dir.exists():
        raise VoiceNotFoundError(f"Voice '{voice_id}' not found.")

    shutil.rmtree(voice_dir)
