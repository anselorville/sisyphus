# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sisyphus is a real-time desktop voice assistant targeting sub-500ms end-to-end latency. It uses a three-tier architecture: React/Tauri frontend, Rust backend with a Pipecat-inspired frame pipeline, and Python inference services for ASR and TTS.

## Development Commands

### Starting the full application
```bash
# 1. Start Python inference services (ASR on :8765, TTS on :8766)
python inference/run_inference.py

# 2. In another terminal, start the Tauri app
npm run tauri dev
```

### Frontend only
```bash
npm run dev        # Vite dev server
npm run build      # tsc && vite build
```

### Rust backend only
```bash
cd src-tauri
cargo build
cargo build --release
```

### Python inference services (individually)
```bash
python inference/run_asr.py   # ASR service only
python inference/run_tts.py   # TTS service only

# Tests
python inference/test_asr.py
python inference/test_tts.py
```

### Python virtual environments
The `inference/` directory uses two separate venvs: `venv-asr` and `venv-tts`. Install deps with:
```bash
pip install -r inference/requirements-asr.txt  # in venv-asr
pip install -r inference/requirements-tts.txt  # in venv-tts
```

## Architecture

### Three-Tier System

```
React UI (src/)
    ↕ Tauri IPC
Rust Backend (src-tauri/src/)
    ↕ WebSocket
Python Inference Services (inference/)
```

### Rust Backend Structure

The backend is organized into four domain modules:

- **`pipeline/`** — Pipecat-inspired frame-based processing system
  - `frames.rs`: `AudioRawFrame { samples: Vec<f32>, sample_rate, channels }`, `TextFrame`, `ControlFrame`
  - `processor.rs`: `async trait Processor { process(frame) -> Vec<Frame> }`
  - `orchestrator.rs`: Tokio-channel-based pipeline composition
- **`audio/`** — cpal-based capture (mic) and playback (speaker) at 24kHz native; `resampler.rs` uses Rubato Sinc FFT to convert 24kHz↔16kHz
- **`conversation/`** — State machine: `Idle → Listening → FinalizingASR → Thinking → Speaking → Idle`
- **`inference/client.rs`** — ASR WebSocket client (sends 16kHz audio, receives transcriptions)
- **`llm/client.rs`** — Streaming OpenAI-compatible client; batches tokens (min 20 tokens or 300ms) and dispatches chunks directly to TTS WebSocket for parallel synthesis

### Audio Pipeline Data Flow

```
Microphone (24kHz) → CaptureProcessor → Resampler (→ 16kHz) → ASR WS (:8765)
                                                                      ↓
                                             LLM (OpenAI-compatible API)
                                                      ↓ streaming tokens
                                    TTS WS (:8766) ← real-time batching
                                           ↓ 24kHz PCM
                     PlaybackProcessor → Speaker (24kHz)
```

### Python Inference Services

- **ASR** (`asr_service.py`): GLM-ASR-Nano-2512, expects 16kHz audio over WebSocket
- **TTS** (`tts_service.py`): Qwen3-TTS at 24kHz, returns PCM audio over WebSocket
- Both services are configured via `inference/models.yaml` (model paths, device, fp16, etc.)

### Frontend

Single main component `src/components/VoiceAssistant.tsx` using Zustand for state. Receives conversation state, transcripts, and audio levels via Tauri IPC events.

## Configuration

Copy `.env.example` to `.env` and fill in:
- `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` — LLM endpoint (OpenAI-compatible)
- `ASR_HOST`/`ASR_PORT` (default 127.0.0.1:8765), `TTS_HOST`/`TTS_PORT` (default 127.0.0.1:8766)

Model paths and inference parameters are in `inference/models.yaml`.

Full environment variable reference: [docs/ENV_CONFIGURATION.md](docs/ENV_CONFIGURATION.md)

## Key Design Patterns

- **Frame pipeline**: All data flows as typed frames through processors. Adding new processing steps means implementing the `Processor` trait and wiring into `orchestrator.rs`.
- **Streaming TTS**: LLM tokens are batched in `llm/client.rs` and sent to TTS before generation completes — this is the primary latency optimization.
- **24kHz throughout**: TTS output and audio playback run at 24kHz natively; only the ASR path downsamples to 16kHz.
- **State machine guards**: Check `conversation/state.rs` before modifying state transitions — invalid transitions are rejected.

## Performance Targets

End-to-end latency target is 400–700ms with CUDA 12.4 (GPU required for inference services). CPU-only is feasible but significantly slower (~5–6s).
