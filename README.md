# Sisyphus Translator

Real-time speech-to-speech translator, browser client now, Raspberry Pi hardware later.

Pipeline: browser mic (WebRTC) -> Silero VAD -> Deepgram streaming STT ->
Anthropic LLM (translation-only prompt) -> Cartesia streaming TTS -> browser
speaker (WebRTC). Built on [Pipecat](https://github.com/pipecat-ai/pipecat).

This is a **translator**, not a chatbot: the LLM step only translates what
you say, it does not converse, answer questions, or add commentary.

Status: rewrite in progress, see `legacy/README.md` for the archived prototype.

## Setup

Requires Python 3.11+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync
cp .env.example .env
```

Edit `.env` and fill in:

- `ANTHROPIC_API_KEY` - translation LLM
- `DEEPGRAM_API_KEY` - streaming speech-to-text
- `CARTESIA_API_KEY` - streaming text-to-speech

Optionally adjust:

- `SOURCE_LANG` / `TARGET_LANG` (default `Chinese` -> `English`). The model
  auto-detects the spoken language and translates into `TARGET_LANG`,
  falling back to `SOURCE_LANG` if you speak in the target language.
  Bidirectional auto-swap and a UI toggle are not implemented yet.
- `WEBRTC_HOST` / `WEBRTC_PORT` (default `0.0.0.0:7860`).

## Run

```bash
uv run python -m app.server
```

Then open `http://localhost:7860` in your browser, click **Connect**, allow
microphone access, and speak. The page shows a connection status indicator
and a live transcript log with both the original transcription and the
translated text. Pipecat's VAD-driven interruption (barge-in) works out of
the box: speaking again while the translator is talking cancels it.

## Offline/local fallback

This is meant to eventually run as a travel translator on a Raspberry Pi,
where wifi/data is often unavailable (rural Europe, etc.). For that, every
cloud service has a local equivalent that runs the *same* pipeline shape
(VAD -> STT -> translation LLM -> TTS) with no internet required at
inference time:

| Stage       | Cloud (default)      | Local/offline fallback                                  |
|-------------|-----------------------|----------------------------------------------------------|
| STT         | Deepgram (streaming) | `faster-whisper` via Pipecat's `WhisperSTTService`        |
| Translation | Anthropic Claude     | A small local model via Ollama (`OLLamaLLMService`)       |
| TTS         | Cartesia (streaming) | Piper via Pipecat's `PiperTTSService`                      |

**Selection is automatic, at startup only.** `app/server.py` builds one
pipeline per WebRTC connection; at that point, `app/pipeline.py` checks for
a working internet connection (`app/connectivity.py`, a fast TCP probe to
`1.1.1.1:53` with a 2s timeout) and uses the local trio if none is found.
There is no mid-conversation switching -- once a pipeline is built for a
connection, it keeps using whichever trio it started with.

To force a choice (e.g. to test the offline path without disconnecting your
network), set in `.env`:

```
FORCE_OFFLINE=true   # always use local services
# or
FORCE_ONLINE=true    # always use cloud services, skip the connectivity probe
```

(Setting both is a startup error.)

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
   > level) specifically so that `import app.pipeline` / `import
   > app.local_services` still succeed on a Mac without this extra; only
   > actually *constructing* the local STT service requires it.

2. **Local translation (Ollama)** -- install
   [Ollama](https://ollama.com/) separately and make sure it's running
   (`ollama serve`, or just launch the desktop app), then pull a small
   instruct model sized for a Pi 5:

   ```bash
   ollama pull qwen2.5:1.5b
   ```

   `OLLAMA_MODEL` defaults to `qwen2.5:1.5b`; `OLLAMA_BASE_URL` defaults to
   `http://localhost:11434/v1` (Ollama's OpenAI-compatible API). Pipecat
   talks to it via `OLLamaLLMService`, using the exact same translation-only
   system prompt as the cloud Anthropic path.

3. **Local TTS (Piper)** -- no separate install needed beyond `uv sync`
   (see `pyproject.toml`'s `piper` extra). The voice model (`PIPER_VOICE`,
   default `en_US-lessac-medium`) is downloaded automatically on first use
   into `PIPER_DOWNLOAD_DIR` (default `./models/piper`). Pick a voice
   matching `TARGET_LANG` -- see
   [Piper's voice list](https://github.com/OHF-Voice/piper1-gpl) for
   options.

All local services run fully offline once their models are downloaded and
Ollama is running -- only the first-run model downloads need network
access.

## What's implemented

- `app/config.py` - env var loading/validation (via `python-dotenv`),
  including the local-fallback settings (`WHISPER_MODEL`, `OLLAMA_*`,
  `PIPER_*`, `FORCE_OFFLINE`/`FORCE_ONLINE`).
- `app/pipeline.py` - Pipecat pipeline construction (transport, VAD, STT,
  translation-only LLM prompt, TTS) plus a small tap processor that forwards
  transcript/translation text to the browser over the WebRTC data channel.
  Picks cloud vs. local services once at build time via
  `should_use_local_services()`.
- `app/local_services.py` - constructs the local/offline STT (Whisper),
  translation (Ollama), and TTS (Piper) service instances, mirroring how the
  cloud equivalents are built in `app/pipeline.py`.
- `app/connectivity.py` - the startup internet-connectivity probe used to
  pick cloud vs. local automatically.
- `app/server.py` - FastAPI/uvicorn app serving the client page and the
  `/api/offer` WebRTC signaling endpoint (`SmallWebRTCTransport`).
- `app/static/index.html` - minimal single-page client (connect button,
  status indicator, transcript log), plain HTML/JS, no build step.

## Known gaps (tracked separately, not this phase)

- Single fixed translation direction per run; no UI toggle or automatic
  bidirectional detection.
- No custom interruption polish beyond Pipecat's default VAD-based barge-in.
- Not yet adapted/tuned for actual Raspberry Pi hardware -- the local
  service choices (model sizes, etc.) are reasonable starting points, not
  benchmarked on a Pi 5 yet.
- Cloud-vs-local selection happens once at startup; there's no
  mid-conversation re-checking or automatic recovery if connectivity changes
  during a call (by design, for this phase).
