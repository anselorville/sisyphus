# Plan: Audio Sampling Rate Optimization & Pipecat Refactor

## TL;DR

> **Quick Summary**: This plan implements a deep audio optimization and architectural refactor based on `docs/SOLUTION_UPGRADE.md`. We will unify the internal sampling rate at 24kHz (matching TTS native rate), replace linear resampling with high-quality `rubato`-based resampling, and adopt a modular "Frame/Processor" pattern inspired by Pipecat.
> 
> **Deliverables**:
> - New Rust `frames` module defining a multi-modal data pipeline.
> - High-quality `Resampler` utility using the `rubato` crate.
> - Refactored TTS Service (Python) outputting 24kHz audio.
> - Refactored Audio Capture & Playback (Rust) using the Processor pattern.
> - Automated test suite for audio quality and pipeline logic.
> 
> **Estimated Effort**: Large (Deep Refactor)
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Frames/Processor Logic → TTS/Audio Refactor → Pipeline Integration

---

## Context

### Original Request
Fix audio quality issues caused by sampling rate mismatches between TTS, ASR, and App capture/playback. Use `docs/SOLUTION_UPGRADE.md` as a guide.

### Interview Summary
**Key Discussions**:
- **Sampling Rate**: Standardized on 24kHz for the high-quality path (TTS -> Playback).
- **Resampling**: Switched from linear interpolation to `rubato` crate in Rust.
- **Architecture**: Move toward Pipecat-style Frame-based processing.
- **Testing**: Enable automated unit tests for both Rust and Python.

### Metis Review (Auto-Simulated due to system error)
**Identified Gaps** (addressed):
- **Buffer Management**: Use `VecDeque` with jitter buffer logic in the PlaybackProcessor.
- **Interrupts**: Handle `CancelFrame` to immediately stop audio playback and clear queues.
- **ASR Downsampling**: Explicitly handle 24kHz -> 16kHz conversion in the ASR path.

---

## Work Objectives

### Core Objective
Achieve crystal-clear audio by matching native model frequencies and using high-fidelity resampling algorithms.

### Concrete Deliverables
- `src-tauri/src/pipeline/frames.rs`: Frame enum definition.
- `src-tauri/src/pipeline/processor.rs`: Processor trait and pipeline logic.
- `src-tauri/src/audio/resampler.rs`: Rubato-based resampling utility.
- `inference/tts_service.py`: Modified to output native 24kHz.
- `src-tauri/src/audio/playback.rs` & `capture.rs`: Refactored to use the new pipeline.

### Definition of Done
- [ ] TTS audio is synthesized at 24kHz and played back without audible artifacts.
- [ ] ASR continues to function accurately using 16kHz downsampled from the 24kHz capture.
- [ ] All Rust unit tests pass (`cargo test`).
- [ ] Interruptions (barge-in) work instantaneously via Control Frames.

### Must Have
- 24kHz internal sampling rate for TTS.
- `rubato` for all resampling operations in Rust.
- Frame-based communication between modules.

### Must NOT Have (Guardrails)
- Linear interpolation for audio resampling.
- Hardcoded 16kHz in the TTS synthesis path.
- Blocking calls in the audio processing thread.

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
> ALL verification is executed by the agent using tools. No exceptions.

### Test Decision
- **Infrastructure exists**: NO (will be set up).
- **Automated tests**: TDD (Write tests first for frame logic).
- **Framework**: `cargo test` (Rust), `pytest` (Python).

### Agent-Executed QA Scenarios

Scenario: Audio Quality Verification (24kHz)
  Tool: Playwright (for UI) + Bash (for logs/files)
  Preconditions: Dev server running, TTS model loaded.
  Steps:
    1. Trigger TTS synthesis for a known text.
    2. Capture the audio output frame metadata from logs.
    3. Assert: `sample_rate == 24000` in `AudioRawFrame`.
    4. Assert: `resampler` is using `rubato` (verify via logs).
  Expected Result: Audio flows at 24kHz with high-quality resampling.
  Evidence: `.sisyphus/evidence/task-audio-24k-verify.log`

Scenario: Interruption Response (Barge-in)
  Tool: Playwright
  Preconditions: Audio playback active.
  Steps:
    1. Emit `speech_start` (simulated user speaking).
    2. Assert: Playback stops within <100ms.
    3. Assert: `CancelFrame` is processed by `PlaybackProcessor`.
  Expected Result: Immediate audio cutoff.
  Evidence: `.sisyphus/evidence/task-interrupt-verify.png`

---

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Foundation):
├── Task 1: Setup Frame/Processor system
└── Task 2: Setup Testing Infrastructure

Wave 2 (Audio & Services):
├── Task 3: Implement Rubato Resampler
├── Task 4: Update TTS Service (Python) to 24kHz
└── Task 5: Refactor Audio Capture (24k/16k)

Wave 3 (Integration):
├── Task 6: Refactor Audio Playback
└── Task 7: Final Pipeline Orchestration

---

## TODOs

- [x] 1. Setup Frame/Processor System
  **What to do**:
  - Create `src-tauri/src/pipeline/mod.rs`, `frames.rs`, `processor.rs`.
  - Define `enum Frame { Audio(AudioRawFrame), Text(TextFrame), Control(ControlFrame) }`.
  - Define `trait Processor { async fn process(&mut self, frame: Frame) -> Result<Vec<Frame>>; }`.
  **Recommended Agent Profile**:
  - **Category**: `ultrabrain`
  - **Skills**: [`tauri`]
  **Acceptance Criteria**:
  - [x] `cargo check` passes with new modules.
  - [ ] Unit test: `Frame` serialization/deserialization works.

- [x] 2. Setup Testing Infrastructure
  **What to do**:
  - Add `pytest` to Python requirements.
  - Add `mock` and `pytest-asyncio`.
  - Ensure `cargo test` is ready for Rust.
  **Acceptance Criteria**:
  - [x] `pytest --version` works in Python venv.
  - [x] `cargo test` executes successfully.

- [ ] 3. Implement Rubato Resampler
  **What to do**:
  - Add `rubato = "0.15"` to `Cargo.toml`.
  - Create `src-tauri/src/audio/resampler.rs`.
  - Implement a wrapper for `FftFixedIn` or `FftFixedOut` to handle real-time streams.
  **Acceptance Criteria**:
  - [ ] Unit test: Resample 24kHz -> 48kHz with <1% error in waveform.
  - [ ] Bench: Resampling 20ms frame takes <1ms.

- [ ] 4. Update TTS Service (Python) to 24kHz
  **What to do**:
  - Modify `inference/tts_service.py`.
  - Remove `librosa.resample` to 16kHz.
  - Set `self.target_sample_rate = 24000`.
  **Acceptance Criteria**:
  - [ ] `test_tts.py` confirms 24kHz output.

- [ ] 5. Refactor Audio Capture (24k/16k)
  **What to do**:
  - Refactor `capture.rs` into `CaptureProcessor`.
  - Outputs 24kHz `AudioRawFrame` for internal use.
  - Includes a sub-path for 16kHz downsampling to send to ASR.
  **Acceptance Criteria**:
  - [ ] ASR still recognizes speech accurately.
  - [ ] Internal audio level monitoring works at 24kHz.

- [ ] 6. Refactor Audio Playback
  **What to do**:
  - Refactor `playback.rs` into `PlaybackProcessor`.
  - Inputs `Frame`, handles `AudioRawFrame` at 24kHz.
  - Resamples to device rate (48k/44.1k) using `rubato`.
  - Implements jitter buffer and `CancelFrame` handling.
  **Acceptance Criteria**:
  - [ ] Audio plays back smoothly without pops or distortion.

- [ ] 7. Final Pipeline Orchestration
  **What to do**:
  - Connect all processors in a main loop or coordinator.
  - Replace old WebSocket handlers with Processor-based ones.
  **Acceptance Criteria**:
  - [ ] End-to-end voice conversation works at 24kHz.
  - [ ] End-to-end latency remains <500ms.

---

## Success Criteria

### Verification Commands
```bash
cargo test
pytest inference/test_tts.py
# Verify audio quality manually via speaker
```

### Final Checklist
- [ ] Internal rate is 24kHz.
- [ ] Rubato is used for all resampling.
- [ ] Frame/Processor architecture implemented.
- [ ] Interruptions are instant.
