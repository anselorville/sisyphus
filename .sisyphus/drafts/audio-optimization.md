# Draft: Audio Sampling Rate Optimization & Pipecat Refactor

## Context
- **Problem**: Audio quality issues due to sampling frequency mismatch and poor resampling.
- **Source of Solution**: `docs/SOLUTION_UPGRADE.md` (Pipecat/Sisyphus architecture).
- **User Decisions**:
    - **Primary Rate**: 24kHz (matches TTS native).
    - **Resampling**: Use `rubato` crate in Rust.
    - **Architecture**: Deep refactor to Pipecat-style Frame/Processor pattern.

## Requirements (confirmed)
- Standardize internal audio flow at 24kHz.
- Implement a Frame-based processing pipeline in Rust.
- Integrate `rubato` for high-quality resampling.
- Ensure ASR still receives 16kHz via quality downsampling.

## Technical Decisions
- **Frame System**: Define `Frame` enum (Audio, Text, Control, etc.) in a new `frames` module.
- **Processors**: Implement `CaptureProcessor`, `PlaybackProcessor`, `TTSProcessor`, `ASRProcessor`.
- **Pipeline**: Implement a simple asynchronous pipeline to route frames.
- **TTS Update**: Modify `tts_service.py` to output 24kHz without downsampling.
- **Playback Update**: Modify `playback.rs` to accept 24kHz and resample to device rate using `rubato`.
- **Capture Update**: Modify `capture.rs` to resample device input to 24kHz (internal) and 16kHz (for ASR).

## Research Findings
- Qwen-TTS native rate is 24kHz.
- ASR (GLM-ASR) typically expects 16kHz.
- Current linear resampling is a major quality bottleneck.

## Open Questions
- [None remaining from initial interview]
