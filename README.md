# Sisyphus Voice Agent

An autonomous swarm voice agent: talk to it, and a swarm of specialized
worker roles (code, web, device, mail, and more, born and retired on
demand) does the work in the background while a single voice presence
keeps the conversation going -- full-duplex, interruptible, and aware of
its own resource budget (an "ecology" that scales itself down under load
and recovers on its own). Browser/desktop client now, Raspberry Pi hardware
later.

Two processes compose the running system:

- **Python media plane** (this repo's `app/`, built on
  [Pipecat](https://github.com/pipecat-ai/pipecat)): browser mic (WebRTC) ->
  Silero VAD -> streaming STT -> streaming TTS -> browser speaker (WebRTC).
  Deliberately carries **no** business LLM/reasoning of its own (see
  `tests/realtime/test_media_pipeline.py::test_media_pipeline_contains_no_business_llm`)
  -- it is purely the audio I/O plane.
- **TypeScript agent-runtime sidecar** (`agent-runtime/`): the actual
  "brain" -- task routing, worker-role castes, ecology/economy budget
  management, isolated role execution, and voice-facing event narration.
  Talks to the media plane over a local event bridge (see
  `app/realtime/event_bridge.py`); the media plane keeps working with full
  STT/TTS even if the sidecar is unreachable.
- **Voice-agent client** (`client/`): a React/Tauri app (browser dev server
  or native desktop shell) that connects to the Python media plane over
  WebRTC and renders the sidecar's task/ecology/elevation state.

See `.proj-init/` for the full swarm-ecology design and phased build plan;
`.proj-init/performance-baseline.md` for measured performance numbers
against the project's own budget. `legacy/README.md` documents the
archived Phase-1 prototype (a from-scratch bidirectional speech
translator) this project was rebuilt from -- superseded, not part of the
running system.

## Setup

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/), plus Node.js
(see `agent-runtime/package.json` and `client/package.json` for the
sidecar and client toolchains).

```bash
uv sync
cp .env.example .env
```

Edit `.env`. Which keys you need depends on which engine you're running --
see "Engines" below. For the default cloud engine, the default stack is
Zhipu GLM ASR (transcription) + Cartesia (speech) + AssemblyAI/Deepgram/
OpenRouter as configurable alternatives -- fill in whichever provider keys
your Model Provider configuration selects (see `GET/PUT
/api/model-providers`, or the client's Settings -> Model Provider screen).
These are only validated (and required) at the moment the cloud engine is
actually selected and a given provider is built -- running with
`ENGINE=offline` or `ENGINE=omlx` needs none of them.

Optionally adjust:

- `WEBRTC_HOST` / `WEBRTC_PORT` (default `0.0.0.0:7860`).

Note: `ANTHROPIC_API_KEY` and the `OLLAMA_*` settings are read by
`app/config.py` but are not currently consumed by any builder in the
Python media plane -- the LLM/reasoning step for a live conversation runs
in the `agent-runtime` sidecar, not in this process (see the architecture
note above). They are kept as available configuration for whoever wires
up a local/Anthropic LLM step in the media plane in the future.

## Run

```bash
uv run python -m app.server
```

Then open `http://localhost:7860` in your browser (a minimal debug page;
the real client lives in `client/`), click **Connect**, allow microphone
access, and speak. `GET /api/status` reports which STT/TTS providers and
turn mode are active; `GET /api/agent-runtime/status` reports the combined
health of the media plane and the sidecar (ecology/food state, sidecar
connectivity).

**Local barge-in / interruption.** In manual turn mode (the default --
see `TURN_MODE` below), `app/realtime/audio_gate.py`'s
`MicGateProcessor`/`TTSOutputGateProcessor` pair gates mic input and
buffers/interrupts TTS output around the mic-open/close boundary: opening
the mic while the agent is speaking clears any buffered/in-flight TTS
audio locally, in the Python process, without needing a round trip to the
sidecar. This is unit-tested (frame-level) in `tests/test_mic_gate.py` and
`tests/test_speculative_pipeline.py`, and latency-budgeted in
`tests/performance/test_barge_in_latency.py`
(`test_local_barge_in_cancel_p95_is_under_budget`). **Caveat:** these
tests confirm the gating/interruption logic is correct and fast at the
frame level; actually hearing audio stop on a live speaker when you talk
over it requires real hardware and has not been manually verified in this
environment (no microphone/speaker available here).

Higher-level voice commands (stop-speech, cancel, steer, follow-up,
new-task) are classified by the agent-runtime sidecar's Reflex Router /
Interruption Router (`agent-runtime/src/routing/`), not by the Python
media plane -- see `agent-runtime/test/routing/interruption-router.test.ts`
and `agent-runtime/test/routing/reflex-router.test.ts`.

### Latency behavior and logs

Final STT fragments pass through a semantic buffer before being published
as a transcript event, so a provider that splits one sentence into
multiple finals does not trigger several partial events. Terminal
punctuation flushes that buffer immediately. An explicit Pipecat user-turn
stop also flushes it immediately; if neither signal arrives, the
unpunctuated fallback wait is capped at **500ms**.

Every pipeline worker installs Pipecat's user-to-bot latency observer.
Search the backend log for `voice_latency` to find:

```text
voice_latency user_to_bot_seconds=0.842
voice_latency first_bot_speech_seconds=0.315
voice_latency breakdown=LatencyBreakdown(...)
```

The first measurement covers user speech end to audible bot speech start.
The breakdown includes the service timing Pipecat can attribute while
metrics are enabled, such as STT finalization, TTS time-to-first-byte, and
text aggregation.

## Engines

There are three engines for the STT/TTS media plane, all running the exact
same pipeline *shape* (VAD -> STT -> TTS, see
`app/realtime/media_pipeline.py`) -- only the concrete STT/TTS service
instances differ. (LLM/reasoning is not part of this selection -- see the
architecture note at the top of this file.)

| Engine    | STT                  | TTS                        | Pi-portable? | When to use |
|-----------|----------------------|------------------------------|--------------|-------------|
| `cloud`   | Zhipu GLM ASR (default) / Deepgram / AssemblyAI / OpenRouter | Cartesia (default) / Edge TTS / MiniMax / OpenRouter / VoxCPM2-CUDA | Yes (needs internet) | Production / has internet |
| `offline` | `faster-whisper` (`WhisperSTTService`) | Piper (`PiperTTSService`) | **Yes** -- the real Raspberry Pi target | No internet, on the eventual Pi hardware |
| `omlx`    | oMLX server (`/v1/audio/transcriptions`) | oMLX server (`/v1/audio/speech`) | **No -- Apple Silicon/MLX only** | Fast local dev/test on a Mac, zero cloud spend, zero network dependency |

Select the engine via `ENGINE` in `.env`:

```
ENGINE=auto      # (default) probe for internet at startup; cloud if found, offline if not
ENGINE=cloud     # always cloud (configured cloud STT/TTS providers)
ENGINE=offline   # always the Pi-portable local fallback (faster-whisper + Piper)
ENGINE=omlx      # always the Mac-only oMLX dev/test engine
```

The legacy `FORCE_OFFLINE=true` / `FORCE_ONLINE=true` flags still work (they
map to `ENGINE=offline` / `ENGINE=cloud` internally) if `ENGINE` itself is
unset; setting both is a startup error. `ENGINE`, if set, always takes
precedence over them.

**Important: `omlx` is not, and will never be, the Raspberry Pi target.** It
depends on [MLX](https://github.com/ml-explore/mlx), Apple's array framework
for Apple Silicon -- there is no Linux/Raspberry Pi backend for it, and there
will not be one. It exists purely so you can iterate on this product quickly
on a Mac (no cloud API spend, no network dependency, fast local models)
without confusing that workflow for actual Pi-portability work, which remains
squarely the `offline` engine's job (faster-whisper + Piper, both of
which do run on Linux/ARM).

### oMLX setup (Mac-only dev engine)

Requires a local oMLX server already running on this machine
(`http://127.0.0.1:6789` by default) with STT and TTS models loaded, served
over its OpenAI-compatible `/v1/audio/transcriptions` and `/v1/audio/speech`
endpoints. See `app/mlx_services.py` for the full reasoning behind the
custom service subclasses this needs.

Set in `.env`:

```
ENGINE=omlx
OMLX_BASE_URL=http://127.0.0.1:6789/v1
OMLX_API_KEY=<your local oMLX key>
OMLX_STT_MODEL=<your configured oMLX STT model>
OMLX_TTS_MODEL=<your configured oMLX TTS model>
```

`OMLX_LLM_MODEL` is also read (for the Model Lab / model-provider "local"
mode surface), but no LLM is built into the Pipecat media pipeline itself
today.

## Offline/local fallback (Raspberry Pi target)

This is meant to eventually run as a travel-friendly voice agent on a
Raspberry Pi, where wifi/data is often unavailable. For that, the STT/TTS
stages each have a local equivalent that runs with no internet required at
inference time:

| Stage | Cloud (default) | Local/offline fallback |
|-------|------------------|-------------------------|
| STT | Zhipu GLM ASR (or Deepgram/AssemblyAI/OpenRouter) | `faster-whisper` via Pipecat's `WhisperSTTService` |
| TTS | Cartesia (or Edge TTS/MiniMax/OpenRouter/VoxCPM2-CUDA) | Piper via Pipecat's `PiperTTSService` |

**Selection happens once, at pipeline-build time.** `app/server.py` builds
one pipeline per WebRTC connection; at that point,
`app/providers/transcription.py`'s `select_engine()` resolves `ENGINE`
(see "Engines" above) -- under `ENGINE=auto`, it checks for a working
internet connection (`app/connectivity.py`, a fast TCP probe to
`1.1.1.1:53` with a 2s timeout) and uses the offline pair if none is
found. There is no mid-conversation switching -- once a pipeline is built
for a connection, it keeps using whichever pair it started with.

### Setting up the local stack

1. **Local STT (faster-whisper)** -- no separate install needed beyond
   `uv sync` (see `pyproject.toml`'s `whisper` extra). The model
   (`WHISPER_MODEL`, default `small`) is downloaded automatically from
   Hugging Face on first use and cached locally. `small` is a reasonable
   multilingual size/accuracy tradeoff for a Pi 5; drop to `base`/`tiny` if
   it's too slow on real hardware, or raise to `medium` if you have headroom
   and want better accuracy. Do not use `large` on a Pi.

   > Apple-Silicon dev-machine note: Pipecat's `pipecat.services.whisper.stt`
   > module unconditionally tries to import `mlx_whisper` on Darwin/arm64
   > hosts (even if you only want the faster-whisper backend used here). If
   > you're developing on an Apple Silicon Mac and want to actually construct
   > `WhisperSTTService` locally, add `uv add "pipecat-ai[mlx-whisper]"` (note:
   > this pulls in `torch`, so it's a dev-only convenience -- the Pi/Linux
   > target never hits this code path). `app/local_services.py` imports
   > Pipecat's Whisper class lazily (inside the function, not at module
   > level) specifically so that `import app.local_services` still succeeds
   > on a Mac without this extra; only actually *constructing* the local STT
   > service requires it.

2. **Local TTS (Piper)** -- no separate install needed beyond `uv sync`
   (see `pyproject.toml`'s `piper` extra). The voice model (`PIPER_VOICE`,
   default `en_US-lessac-medium`) is downloaded automatically on first use
   into `PIPER_DOWNLOAD_DIR` (default `./models/piper`). Pick a voice
   matching the language you want spoken -- see
   [Piper's voice list](https://github.com/OHF-Voice/piper1-gpl) for
   options.

Both run fully offline once their models are downloaded -- only the
first-run model download needs network access.

## What's implemented

- `app/config.py` - env var loading (via `python-dotenv`), engine selection
  (`ENGINE`, with `FORCE_OFFLINE`/`FORCE_ONLINE` backward compat --
  `_resolve_engine()`), and the offline-fallback (`WHISPER_MODEL`,
  `PIPER_*`) and oMLX (`OMLX_*`) settings.
- `app/realtime/media_pipeline.py` - builds the STT -> TTS media pipeline
  for one WebRTC connection (no business LLM -- see
  `tests/realtime/test_media_pipeline.py`), wires the manual-turn-mode mic
  gate, and (`build_pipeline_worker`) wraps it in a `PipelineWorker` with
  the latency observer attached.
- `app/providers/` - STT (`transcription.py`) and TTS (`speech.py`)
  provider selection: resolves `ENGINE`, dispatches to cloud (Zhipu/
  Deepgram/AssemblyAI/Cartesia/Edge TTS/MiniMax/OpenRouter/VoxCPM2-CUDA),
  offline (`app/local_services.py`), or oMLX (`app/mlx_services.py`)
  service builders.
- `app/realtime/` - the rest of the realtime media plane: audio gating
  (`audio_gate.py`), turn detection and the semantic sentence buffer
  (`turn_detection.py`), transcript event publication
  (`transcription.py`), the outbound speech queue
  (`speech_queue.py`/`queueing.py`), the realtime event contract
  (`events.py`), and the sidecar event bridge (`event_bridge.py`).
- `app/model_providers.py` / `app/model_settings.py` / `app/model_adapters/`
  - the "Model Provider" (which provider/model serves each capability) and
  "Model Lab" (tuning whichever provider/model is active) configuration
  surfaces, backing `/api/model-providers` and `/api/model-lab/*`.
- `app/connectivity.py` - the startup internet-connectivity probe used by
  `ENGINE=auto` to pick cloud vs. offline automatically.
- `app/server.py` - FastAPI/uvicorn app serving the client page, the
  `/api/offer` WebRTC signaling endpoint (`SmallWebRTCTransport`),
  `GET /api/status` / `GET /api/agent-runtime/status`, and the Model
  Provider/Model Lab/voice-library HTTP surface.
- `app/static/index.html` - minimal fallback single-page client (connect
  button, status indicator, transcript log), plain HTML/JS, no build step.
  The real client is `client/`.
- `agent-runtime/` - the TypeScript sidecar: protocol/transport, worker
  roles and castes, task routing, ecology/economy budget management,
  isolated role execution, and voice narration. See `.proj-init/` for the
  full design and `agent-runtime/test/` for its test suite.
- `client/` - the React/Tauri voice-agent frontend (`AgentHomeScreen` and
  its subtree: talk control, task nest, ecology panel, elevation dialog),
  plus Settings/Model Lab/Model Provider configuration screens.

## Known gaps (tracked separately, not this phase)

- Not yet adapted/tuned for actual Raspberry Pi hardware -- the local
  service choices (model sizes, etc.) are reasonable starting points, not
  benchmarked on a Pi 5 yet; see `.proj-init/performance-baseline.md`'s
  Raspberry Pi section, which is explicitly pending real hardware access.
- Cloud-vs-local selection happens once at startup; there's no
  mid-conversation re-checking or automatic recovery if connectivity changes
  during a call (by design, for this phase).
- Live, end-to-end voice conversation against real hardware (microphone,
  speaker) and real cloud/LLM credentials has not been manually verified in
  this development environment -- see
  `.proj-init/06-software-release-acceptance.md` for exactly what has and
  has not been verified, and how.
