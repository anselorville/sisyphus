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

- `SOURCE_LANG` / `TARGET_LANG` (default `Chinese` -> `English`). Translation
  is **bidirectional and automatic, per utterance**: the model is told both
  configured languages and, for each utterance, detects which of the two was
  just spoken and translates into the *other* one -- no manual toggle, no UI
  "swap direction" button, and no fixed "always SOURCE_LANG -> TARGET_LANG"
  assumption. A traveler can go back and forth (e.g. speak Chinese, get
  French; the other person replies in French, gets Chinese back) without
  touching any setting. The detected direction for the most recent utterance
  (e.g. `ZH -> FR`) is shown as a small badge next to each translated line in
  the transcript log.
  - `TARGET_LANG` (and `SOURCE_LANG`) accept free-text language names; the
    following values are explicitly supported end-to-end (system prompt
    wording + Cartesia TTS voice selection): `English`, `French`, `German`,
    `Spanish`, `Italian` (plus `Chinese`, the default `SOURCE_LANG`). Other
    values still work for the LLM prompt (it's just text), but TTS will fall
    back to the English voice for languages not in
    `app.pipeline.CARTESIA_VOICE_IDS`.
  - How direction detection works: the LLM is instructed (see
    `app.pipeline.build_translation_system_prompt`) to prefix its output with
    a small tag, `[XX->YY]` (e.g. `[ZH->FR] Bonjour`), naming the language
    codes it detected as source/destination, followed by the translation and
    nothing else. `app.pipeline.TranslationDirectionStripper` parses and
    strips this tag before the text reaches TTS (so it's never spoken aloud),
    and the parsed direction is attached as a `direction` field on the
    existing `"transcript"` data-channel JSON message (no new message type).
    A prompt-based tag was chosen over Anthropic tool-calls/structured output
    specifically so the *same* mechanism works for the local Ollama LLM path
    too (a small local instruct model isn't a good fit for tool-call-based
    structured output, and cloud/local taking different approaches risked
    them silently behaving differently).
  - Reliability note: this is LLM-output-format compliance, not a guaranteed
    contract -- a model could occasionally omit/malform the tag. If that
    happens, the translation still gets spoken (the prefix regex simply finds
    nothing to strip), only the direction badge is stale/missing for that one
    utterance; nothing breaks downstream.
- `WEBRTC_HOST` / `WEBRTC_PORT` (default `0.0.0.0:7860`).

## Run

```bash
uv run python -m app.server
```

Then open `http://localhost:7860` in your browser, click **Connect**, allow
microphone access, and speak. The page shows a connection status indicator
and a live transcript log with both the original transcription and the
translated text, with a `XX -> YY` direction badge on each translated line
(see "Bidirectional translation" above).

**Barge-in/interruption is explicitly enabled.** `app/pipeline.py`'s
`build_pipeline()` constructs `LLMUserAggregatorParams.user_turn_strategies`
with `VADUserTurnStartStrategy(enable_interruptions=True)` and
`TranscriptionUserTurnStartStrategy(enable_interruptions=True)` -- speaking
again while the translator is talking emits an interruption frame that
cancels in-flight LLM/TTS work, so the bot stops talking immediately rather
than finishing its sentence. This is spelled out explicitly (rather than
relying on Pipecat's own defaults, which happen to already be `True`)
because the previous phase assumed "comes for free" without ever
constructing/verifying it. **Caveat:** this confirms the flag is set and the
pipeline constructs correctly with it; actually hearing the bot's audio cut
off mid-sentence when you talk over it requires real API keys and a
microphone, which wasn't available in this phase -- that live check is
remaining work for whoever has working credentials.

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

**Cartesia voice selection (cloud TTS) is per-`TARGET_LANG`, via a single
multilingual voice.** Cartesia's `sonic-3.5` model (used here) is
multilingual: per Cartesia's own docs/blog, a single voice recording can be
rendered correctly in any of ~40+ supported languages just by setting the
`language` field -- the model adapts pronunciation/prosody automatically, no
separate voice clone per language needed. `app.pipeline.CARTESIA_VOICE_IDS`
maps each supported `TARGET_LANG` (English, French, German, Spanish,
Italian) to a voice_id, and every entry currently points at the *same*
voice_id (`71a7ad14-...`, "British Reading Lady" -- the one voice_id
verified to exist on a real account, carried over from the Phase 1
prototype). `app.pipeline.cartesia_voice_for_language()` picks the voice and
`cartesia_language_for()` picks the matching `Language` enum value, so
`CartesiaTTSService.Settings(voice=..., language=...)` gets the right pair
for whatever `TARGET_LANG` is configured.

This was a deliberate choice over inventing distinct per-language voice IDs:
no real `CARTESIA_API_KEY` was available while implementing this, so any
other voice_id would be an unverifiable guess. Once real credentials exist,
browsing Cartesia's voice library (cartesia.ai/voices or the `/voices` API,
filtered by `language`) and swapping in a voice actually recorded in each
target language (for a more native-sounding accent) is a one-line change
per entry in `CARTESIA_VOICE_IDS` -- see the `TODO(orchestrator...)` comment
there. Adding a new `TARGET_LANG` entirely is a small addition to both
`CARTESIA_VOICE_IDS` and `_LANGUAGE_CODES`, no other code changes.

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
  bidirectional translation-only LLM prompt, TTS) plus: a
  `TranslationDirectionStripper` that parses/strips the LLM's `[XX->YY]`
  direction tag before TTS, a small tap processor that forwards
  transcript/translation text (plus the detected `direction`) to the browser
  over the WebRTC data channel, explicit barge-in configuration
  (`enable_interruptions=True`), and the Cartesia per-language voice
  selection. Picks cloud vs. local services once at build time via
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

- Direction detection relies on the LLM reliably emitting a well-formed
  `[XX->YY]` tag (see "Bidirectional translation" above); not a hard
  guarantee, though failures degrade gracefully (translation still plays,
  only the UI direction badge is affected).
- Barge-in is explicitly configured (`enable_interruptions=True`) and the
  pipeline constructs correctly with it, but actual interruption behavior
  under live audio (does the bot's speech audibly stop when talked over) has
  **not** been verified end-to-end -- no real API keys or microphone were
  available in this phase. Verifying this live is remaining work.
- `app.pipeline.CARTESIA_VOICE_IDS` currently maps every supported
  `TARGET_LANG` to the *same* single voice_id (the one known-real voice
  carried over from Phase 1), relying on Cartesia's multilingual model
  rather than per-language voice recordings -- see the README section above
  for why. Neither this nor the underlying multilingual-rendering claim was
  verified by actually generating audio (no real Cartesia API key was
  available). Once credentials exist: (1) confirm sonic-3.5 actually
  produces correct French/German/Spanish/Italian speech from this one
  voice+language combination, and (2) consider browsing Cartesia's voice
  library for a more native-sounding voice per language.
- Not yet adapted/tuned for actual Raspberry Pi hardware -- the local
  service choices (model sizes, etc.) are reasonable starting points, not
  benchmarked on a Pi 5 yet.
- Cloud-vs-local selection happens once at startup; there's no
  mid-conversation re-checking or automatic recovery if connectivity changes
  during a call (by design, for this phase).
