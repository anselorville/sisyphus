# Learnings: audio-optimization-refactor

## Architectural Decisions
- Unify internal sampling rate at 24kHz.
- Adopt Pipecat-style Frame/Processor pattern.
- Use `rubato` for high-quality resampling in Rust.

## Conventions
- Audio frames are 20ms chunks (480 samples @ 24kHz).
- `Frame` enum for multi-modal data.
- Async `Processor` trait.
