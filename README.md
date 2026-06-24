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

## What's implemented

- `app/config.py` - env var loading/validation (via `python-dotenv`).
- `app/pipeline.py` - Pipecat pipeline construction (transport, VAD, STT,
  translation-only LLM prompt, TTS) plus a small tap processor that forwards
  transcript/translation text to the browser over the WebRTC data channel.
- `app/server.py` - FastAPI/uvicorn app serving the client page and the
  `/api/offer` WebRTC signaling endpoint (`SmallWebRTCTransport`).
- `app/static/index.html` - minimal single-page client (connect button,
  status indicator, transcript log), plain HTML/JS, no build step.

## Known gaps (tracked separately, not this phase)

- Single fixed translation direction per run; no UI toggle or automatic
  bidirectional detection.
- No custom interruption polish beyond Pipecat's default VAD-based barge-in.
- Not yet adapted for Raspberry Pi / dedicated hardware.
