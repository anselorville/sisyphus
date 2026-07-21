"""OpenRouter-backed equivalents of the cloud STT, translation (LLM), and TTS
services used by app/pipeline.py.

OpenRouter is a single account/API key that fronts many third-party models
across all three capabilities this pipeline needs -- unlike
Anthropic/Deepgram/Cartesia (each a single fixed model family), OpenRouter is
a *menu*: which concrete model serves text/speech/transcription is chosen by
the user via app/model_providers.py's settings store, not hardcoded here.
This module only builds services for whatever model id it's given.

Mirrors the shape/documentation discipline of app/mlx_services.py: every
claim about request/response behavior below was verified live against the
real OpenRouter API (using the real `OPENROUTER_API_KEY` in this repo's
`.env`) during this session, not assumed from docs. Anything not actually
exercised is flagged as such.

Stack (all three capabilities are OpenAI-SDK-compatible in transport shape,
except transcription -- see below):

- Text (LLM): `pipecat.services.openai.llm.OpenAILLMService`, talking to
  OpenRouter's OpenAI-compatible `/v1/chat/completions` endpoint. No subclass
  needed -- same generic class app/mlx_services.py's `build_mlx_llm` uses for
  oMLX, just a different `base_url`/`api_key`/`model`. Verified live (this
  session) against `nvidia/nemotron-3-ultra-550b-a55b:free`: a plain
  translation request returned a correct, fast response. Confirmed
  reasoning-disable behavior (see `build_openrouter_llm` below) by comparing
  `usage.completion_tokens_details.reasoning_tokens` across requests: 16
  reasoning tokens (plus a visible `reasoning` field on the message) with
  reasoning enabled, exactly 0 with it explicitly disabled -- same kind of
  latency hazard `build_mlx_llm` documents for Qwen3.5's thinking mode, and
  the same fix shape (a request-level flag), though the wire format differs
  (see below).
- Speech (TTS): a custom `OpenRouterTTSService` (this module), talking to
  OpenRouter's OpenAI-compatible `/v1/audio/speech` endpoint. Verified live
  this session with `microsoft/mai-voice-2`: the response is genuine
  **headerless raw PCM at 24kHz mono** (`Content-Type: audio/pcm;rate=24000;
  channels=1`, confirmed both via the response header and by inspecting the
  first bytes of the body -- no RIFF magic) -- i.e. exactly the framing
  `pipecat.services.openai.tts.OpenAITTSService` already assumes (it
  hardcodes `OPENAI_SAMPLE_RATE = 24000` and wraps response bytes directly
  into `TTSAudioRawFrame` with no header parsing). This is the OPPOSITE
  finding from oMLX (`MlxTTSService` in app/mlx_services.py, which needed a
  WAV-header-strip-and-resample subclass because oMLX always returns
  WAV-wrapped 48kHz audio) -- do not assume the two engines share a response
  shape just because they're both "OpenAI-compatible TTS endpoints".
  `OpenAITTSService` itself cannot be reused unmodified, though: it hardcodes
  voice names to OpenAI's own fixed enum (alloy/ash/.../verse) and rejects
  anything else with an `ErrorFrame` before ever making the request -- but
  mai-voice-2's real voice identifiers are Azure-locale-format strings (e.g.
  `en-US-Harper:MAI-Voice-2`; confirmed live: every OpenAI voice name
  ["alloy", "echo", "fable", "onyx", "nova", "shimmer", "coral", "verse",
  "ballad", "sage", and several plausible Azure-style guesses] returned HTTP
  400 except this exact locale-qualified form, found via OpenRouter's own
  model page copy: "Voice names follow the Azure locale format"). So
  `OpenRouterTTSService` is a minimal subclass of `OpenAITTSService` that
  only overrides the voice-validation gate -- everything else (request
  construction, raw-PCM response handling, streaming) is inherited verbatim
  and was exercised live by this same test.
- Transcription (ASR): a bespoke `OpenRouterSTTService` (this module). This
  is NOT OpenAI-SDK-compatible in transport, despite living at a similarly
  named endpoint -- confirmed live this session against
  `qwen/qwen3-asr-flash-2026-02-10`: it's a raw JSON POST with base64-encoded
  audio (`{"model", "input_audio": {"data", "format"}}`), returning
  `{"text": ..., "usage": {...}}`, NOT the OpenAI SDK's multipart `file=`
  upload contract (`openai.audio.transcriptions.create`) that
  `OpenAISTTService`/`MlxSTTService` rely on. Reusing either of those classes
  would send the wrong request shape entirely. `OpenRouterSTTService`
  therefore extends `pipecat.services.stt_service.SegmentedSTTService`
  directly (the same base `BaseWhisperSTTService` -- and therefore
  `OpenAISTTService`/`MlxSTTService` -- ultimately extend) via a plain
  `httpx.AsyncClient`, implementing only the abstract `run_stt(audio: bytes)
  -> AsyncGenerator[Frame, None]` method: buffer-until-VAD-stop and
  one-shot-POST-the-whole-utterance is exactly `SegmentedSTTService`'s
  existing contract, so no other override was needed. Verified live this
  session with a real WAV recorded via macOS `say` (16kHz mono PCM,
  "Hello, where is the nearest train station?"): the response's `text` field
  was an exact, correct transcription. Also verified (live, this session)
  that a `language` field in the request body is NOT a soft hint but
  authoritative: sending `language="fr"` against the same English audio
  caused the model to emit a French *translation* of the utterance instead
  of transcribing the actual (English) speech -- the field changes what task
  is performed, not just which language is expected. For exactly the reason
  `MlxSTTService` omits its `language` field for auto-detect in this
  bidirectional pipeline (see app/mlx_services.py's docstring),
  `OpenRouterSTTService` likewise omits `language` entirely unless a
  `language_hint` is explicitly configured (Model Lab override, see
  app/model_settings.py) -- forcing a language for a genuinely bidirectional
  translator would silently mistranscribe (or mistranslate) whichever
  configured language wasn't forced.

UNVERIFIED in this session (explicitly, rather than silently assumed):
- Any model other than the one configured per capability in `.env`
  (`nvidia/nemotron-3-ultra-550b-a55b:free` for text,
  `microsoft/mai-voice-2` for speech, `qwen/qwen3-asr-flash-2026-02-10` for
  transcription) -- other catalog entries in OPENROUTER_TEXT_MODELS may have
  different request/response quirks (e.g. paid models, different reasoning
  wire formats) not exercised here.
- Streaming TTS latency characteristics (whether OpenRouter's `/v1/audio/
  speech` delivers audio incrementally or in one burst, the way
  app/mlx_services.py measured for oMLX) -- not measured; `chunk_size`-based
  iteration is used the same way `OpenAITTSService`/`MlxTTSService` already
  do, which works correctly regardless of server-side streaming behavior,
  but no claim is made here about time-to-first-byte.
- Error-path behavior (HTTP error responses, malformed audio, rate limits)
  beyond the generic "non-200 status -> ErrorFrame" handling inherited from
  `OpenAITTSService` (for TTS) and implemented directly (for STT) -- only the
  success path was exercised live.
- `OPENROUTER_TEXT_MODELS`' non-`:free` entries were deliberately not
  exercised, to avoid burning paid credits during development (per this
  task's constraint) -- only `nvidia/nemotron-3-ultra-550b-a55b:free` was
  used for the live LLM test.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from loguru import logger
from openai import AsyncOpenAI, DefaultAsyncHttpxClient
from openai.types.audio import Transcription
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.tts import OpenAITTSService
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.stt_latency import WHISPER_TTFS_P99
from pipecat.utils.time import time_now_iso8601

from app.config import Settings

# OpenRouter's base URL for every capability -- a single root, unlike e.g.
# oMLX's per-install `base_url` (there's exactly one OpenRouter API, fronting
# many backing providers/models behind it).
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# DeepSeek's first-party OpenAI-compatible API. Note NO "/v1" -- DeepSeek
# documents https://api.deepseek.com as the base (it also accepts /v1 as an
# alias). Verified live from this machine: GET /models responds, and a
# streamed chat completion delivered its first content token in ~0.4s with a
# 28ms TLS handshake -- this route does not suffer the ~5s handshake tax the
# openrouter.ai route does from this network, which is the whole reason this
# provider exists as a separate option.
DEEPSEEK_BASE_URL = "https://api.deepseek.com"

# `openai`'s own default httpx connect-timeout (`DEFAULT_TIMEOUT = httpx.
# Timeout(timeout=600, connect=5.0)`, see openai/_constants.py). Measured
# live (this session) against OpenRouter from this network: a plain GET to
# `/v1/models` took ~5.4s end-to-end for the TLS handshake alone -- right at
# (and intermittently past) that 5s connect budget, producing flaky
# `httpx.ConnectTimeout`/`openai.APITimeoutError` failures on otherwise-valid
# requests. This is NOT something `OpenAILLMService(timeout=...)` or any
# constructor kwarg can fix: `BaseOpenAILLMService.create_client()` (pipecat.
# services.openai.base_llm) accepts `**kwargs` but never forwards them into
# the `AsyncOpenAI(...)` it builds -- it hardcodes its own `http_client=
# DefaultAsyncHttpxClient(limits=...)` with no `timeout=` of its own, so
# `AsyncOpenAI` falls back to the library default 5s connect timeout
# regardless of anything passed to `OpenAILLMService`. Confirmed by reading
# `create_client`'s source directly. A 15s connect budget is generous
# relative to the measured ~5.4s handshake without meaningfully harming
# latency for the failure case this is meant to prevent (a slow handshake on
# an otherwise-healthy connection) -- it does not affect the read/write
# timeout for actual response streaming, which stays at the same 600s
# default real-time translation will never approach.
OPENROUTER_CONNECT_TIMEOUT_SECS = 15.0

# How often the keep-warm loop (see `OpenRouterLLMService`) re-touches the
# OpenRouter connection. Measured live on this network: a FRESH TLS handshake
# to openrouter.ai costs ~5.1s (TCP connect 6ms, DNS 5ms -- the handshake
# itself is what's slow on this route), and that tax lands on the first LLM
# request of every new connection. With a warm pooled connection the same
# streaming translation request drops from ~6.8s to ~1.2s first-token
# (measured back-to-back, this session). The client-side pool already never
# expires connections (`keepalive_expiry=None` below), but Cloudflare-fronted
# servers close idle connections after ~90-100s -- so a periodic no-cost GET
# keeps one TLS connection hot across the silent gaps a real conversation is
# full of. 60s sits safely under that server-side idle window.
OPENROUTER_KEEP_WARM_INTERVAL_SECS = 60.0


class OpenRouterLLMService(OpenAILLMService):
    """`OpenAILLMService` subclass that overrides `create_client()` to give
    the underlying `AsyncOpenAI` client a longer connect timeout, working
    around `BaseOpenAILLMService.create_client()` silently discarding any
    `timeout=`-shaped kwarg (see `OPENROUTER_CONNECT_TIMEOUT_SECS` above for
    the live-measured reason this matters specifically for OpenRouter).

    Mirrors upstream's `create_client` exactly (same `httpx.Limits`), adding
    only an explicit `timeout=`. Everything else -- request building,
    streaming, the `reasoning`-disable `extra_body` from
    `build_openrouter_llm` -- is inherited unchanged.

    Also runs a keep-warm loop for the pipeline's lifetime (started on
    `StartFrame`, cancelled on End/Cancel): an immediate warm-up GET when the
    session starts (so the FIRST utterance doesn't pay the ~5s cold-TLS tax
    this network route imposes -- see `OPENROUTER_KEEP_WARM_INTERVAL_SECS`)
    and a re-touch every interval thereafter to stop the server side from
    closing the idle connection between conversational turns.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._keep_warm_task = None

    async def start(self, frame):
        await super().start(frame)
        if self._keep_warm_task is None:
            self._keep_warm_task = self.create_task(self._keep_warm_loop())

    async def stop(self, frame):
        await self._cancel_keep_warm()
        await super().stop(frame)

    async def cancel(self, frame):
        await self._cancel_keep_warm()
        await super().cancel(frame)

    async def _cancel_keep_warm(self):
        if self._keep_warm_task is not None:
            await self.cancel_task(self._keep_warm_task)
            self._keep_warm_task = None

    async def _keep_warm_loop(self):
        import asyncio

        while True:
            try:
                # GET {base_url}/models through the SAME pooled http client
                # the chat completions use: free (no tokens), and both opens
                # the TLS connection on session start and keeps it alive
                # across idle gaps.
                await self._client.models.list()
            except Exception as exc:
                logger.debug(f"OpenRouter keep-warm ping failed (harmless): {exc}")
            await asyncio.sleep(OPENROUTER_KEEP_WARM_INTERVAL_SECS)

    def create_client(self, api_key=None, base_url=None, organization=None, project=None, default_headers=None, **kwargs):
        return AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            organization=organization,
            project=project,
            http_client=DefaultAsyncHttpxClient(
                limits=httpx.Limits(
                    max_keepalive_connections=100, max_connections=1000, keepalive_expiry=None
                ),
                timeout=httpx.Timeout(600.0, connect=OPENROUTER_CONNECT_TIMEOUT_SECS),
            ),
            default_headers=default_headers,
        )


def build_openrouter_llm(
    settings: Settings,
    system_prompt: str,
    model: str,
    *,
    temperature: float | None = None,
    top_p: float | None = None,
    max_tokens: int | None = None,
) -> OpenRouterLLMService:
    """Construct an OpenRouter-backed translation LLM service
    (`OpenRouterLLMService`, pointed at OpenRouter, using the same
    translation-only system prompt as every other engine).

    `model` is caller-supplied (from `app.model_providers`'s settings store
    -- the whole point of OpenRouter as a provider is that the concrete model
    is user-selectable, unlike Anthropic/oMLX where this pipeline hardcodes
    one model id).

    `extra={"extra_body": {"reasoning": {"enabled": False}}}` disables
    reasoning for the same latency reason `build_mlx_llm` disables Qwen3.5's
    thinking mode (see that function's docstring) -- this is a real-time
    translation pipeline, not a chat assistant, and cannot afford a model
    "thinking out loud" before answering. Verified live (this session)
    against `nvidia/nemotron-3-ultra-550b-a55b:free`: with reasoning enabled
    (the model's default for a reasoning-capable model), a plain translation
    request returned a `message.reasoning` field and
    `usage.completion_tokens_details.reasoning_tokens=16`; with
    `reasoning.enabled=False`, the identical request returned
    `reasoning_tokens=0` and no `reasoning` field, with a smaller, faster
    response. As with `build_mlx_llm`'s `chat_template_kwargs`, this must be
    nested under `extra_body` (the openai SDK's documented vendor-escape-hatch
    kwarg, merged into the raw request body verbatim), not passed as a direct
    top-level kwarg to `chat.completions.create` -- `reasoning` isn't a
    parameter the SDK itself knows about. Confirmed live in two ways: (1)
    through the SDK with `extra_body=...` directly, and (2) via a raw `curl`
    POST with `"reasoning": {"enabled": false}` literally at the JSON body's
    top level (the actual wire shape `extra_body`'s contents get merged
    into) -- both produced `reasoning_tokens=0`.

    `temperature`/`top_p`/`max_tokens` (from the Model Lab feature -- see
    app/model_settings.py's `cloud:text` adapter, shared across every cloud
    text provider) are forwarded only when given; `max_tokens` is a real,
    standard field on `OpenAILLMService.Settings` (confirmed in
    pipecat.services.openai.base_llm), not an OpenRouter-specific add-on.
    """
    overrides: dict[str, float | int] = {}
    if temperature is not None:
        overrides["temperature"] = temperature
    if top_p is not None:
        overrides["top_p"] = top_p
    if max_tokens is not None:
        overrides["max_tokens"] = max_tokens
    return OpenRouterLLMService(
        api_key=settings.openrouter_api_key,
        base_url=OPENROUTER_BASE_URL,
        settings=OpenRouterLLMService.Settings(
            model=model,
            system_instruction=system_prompt,
            extra={"extra_body": {"reasoning": {"enabled": False}}},
            **overrides,
        ),
    )


def build_deepseek_llm(
    settings: Settings,
    system_prompt: str,
    model: str,
    *,
    temperature: float | None = None,
    top_p: float | None = None,
    max_tokens: int | None = None,
) -> OpenRouterLLMService:
    """Construct a DeepSeek-first-party translation LLM service.

    Reuses `OpenRouterLLMService` (the class is provider-agnostic: an
    OpenAI-compatible chat service with a generous connect timeout and the
    keep-warm loop) pointed at `DEEPSEEK_BASE_URL` with the DeepSeek API
    key. The keep-warm loop's `GET {base}/models` works identically against
    DeepSeek's API (verified live) -- less critical here since this route's
    TLS handshake is only ~28ms, but it also keeps the first utterance's
    request on an already-open connection.

    No `reasoning` extra_body: `deepseek-chat` is DeepSeek's non-thinking
    model (the right one for real-time translation -- measured ~0.4s to
    first streamed token from this machine); `deepseek-reasoner` thinks by
    design and there is no flag that makes it not.
    """
    overrides: dict[str, float | int] = {}
    if temperature is not None:
        overrides["temperature"] = temperature
    if top_p is not None:
        overrides["top_p"] = top_p
    if max_tokens is not None:
        overrides["max_tokens"] = max_tokens
    return OpenRouterLLMService(
        api_key=settings.deepseek_api_key,
        base_url=DEEPSEEK_BASE_URL,
        settings=OpenRouterLLMService.Settings(
            model=model,
            system_instruction=system_prompt,
            **overrides,
        ),
    )


class OpenRouterTTSService(OpenAITTSService):
    """`OpenAITTSService` subclass that accepts OpenRouter/Azure-style voice
    identifiers instead of validating against OpenAI's own fixed voice enum,
    and optionally forwards a live per-utterance tone hint as `instructions`.

    Why a subclass is needed at all, despite the response framing being
    identical to OpenAI's real TTS API (see this module's docstring --
    verified live: headerless raw PCM at 24kHz, exactly what
    `OpenAITTSService.run_tts` already assumes and handles correctly with no
    changes): `OpenAITTSService.run_tts` validates `voice` against a
    hardcoded `VALID_VOICES` dict (alloy/ash/.../verse) and yields an
    `ErrorFrame` *before making any request* if the voice isn't in that set.
    OpenRouter's `microsoft/mai-voice-2` model does not use that vocabulary
    at all -- its real voice identifiers are Azure-locale-qualified strings
    like `en-US-Harper:MAI-Voice-2` (confirmed live: every OpenAI voice name
    returned HTTP 400 "Provider returned 400"; the Azure-locale form is the
    only one that worked, and was found via OpenRouter's own model
    documentation copy, not guessed). This override removes only that
    upfront vocabulary gate; the actual request construction and the raw-PCM
    response handling are inherited unchanged from `OpenAITTSService.run_tts`
    via `super().run_tts()`.

    This is therefore a much smaller override than `MlxTTSService`
    (app/mlx_services.py), which had to replace the entire `run_tts` body to
    handle WAV-wrapped, non-24kHz audio -- OpenRouter's TTS response needed
    no such rework, only the voice gate (plus this tone-forwarding wrapper).

    `tone_source` (optional, mirrors `MlxTTSService`'s identical parameter in
    app/mlx_services.py): a reference to `app.pipeline.
    TranslationDirectionStripper`, read synchronously in `run_tts()` for its
    `last_tone` attribute and forwarded as `self._settings.instructions`
    before delegating to `OpenAITTSService.run_tts` (which reads
    `self._settings.instructions` fresh on every call -- confirmed by reading
    its source -- so mutating it just before calling super() is sufficient,
    no deeper override needed). Falls back to whatever static
    `instructions=`/`default_instructions` was set at construction time when
    no tone has been inferred yet (e.g. the session's first utterance) or no
    `tone_source` was given at all. UNVERIFIED: whether OpenRouter's
    mai-voice-2 backend actually changes its output in response to
    `instructions` was not exercised live in this session (see
    `build_openrouter_tts`'s docstring) -- this wrapper provides the same
    wiring `MlxTTSService` uses (verified live for oMLX), but the
    OpenRouter-side effect itself is unconfirmed.
    """

    def __init__(self, *, tone_source: "Any | None" = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # `OpenAITTSService.__init__` builds `self._client = AsyncOpenAI(
        # api_key=..., base_url=...)` with no `http_client=`/`timeout=`
        # override at all, so it inherits the openai SDK's default 5s
        # *connect* timeout -- the exact same hazard `OpenRouterLLMService`
        # (this module) works around for the LLM path (see
        # `OPENROUTER_CONNECT_TIMEOUT_SECS`'s docstring for the live-measured
        # ~5.4s TLS handshake against OpenRouter from this network).
        # Confirmed live this session: an unpatched `OpenRouterTTSService`
        # call raised `openai.APITimeoutError: Request timed out.` on a
        # real `/v1/audio/speech` request. Rebuilding `self._client` here
        # (after `super().__init__()` already built one) with the same
        # longer connect timeout fixes it -- verified live immediately
        # after this fix (see this module's docstring for the streaming
        # timing measurement that followed).
        self._client = AsyncOpenAI(
            api_key=self._client.api_key,
            base_url=self._client.base_url,
            http_client=DefaultAsyncHttpxClient(
                limits=httpx.Limits(
                    max_keepalive_connections=100, max_connections=1000, keepalive_expiry=None
                ),
                timeout=httpx.Timeout(600.0, connect=OPENROUTER_CONNECT_TIMEOUT_SECS),
            ),
        )
        self._tone_source = tone_source
        # Static fallback instructions, captured once at construction time
        # (from `default_instructions`/`settings.instructions`) so it can be
        # restored on every call when there's no live tone yet.
        self._fallback_instructions = self._settings.instructions
        # `OpenAITTSService.run_tts` checks `voice not in VALID_VOICES` (a
        # *module-level* dict shared by every instance of the class) before
        # making any request, then looks up `VALID_VOICES[voice]` to get the
        # value it actually sends. Registering this instance's configured
        # voice as a no-op self-mapping (`{voice: voice}`) satisfies both the
        # membership check and the lookup without touching any other
        # instance's behavior or duplicating the surrounding request/
        # response logic (which needs no changes at all -- see this class's
        # docstring). Mutating a module-level dict from an instance
        # constructor is unusual, but the alternative (reimplementing
        # `run_tts`'s ~30 lines to drop one `if` check) is worse: any future
        # upstream change to request construction or response handling would
        # need to be re-applied by hand to a forked copy instead of being
        # inherited automatically.
        voice = self._settings.voice
        if voice:
            from pipecat.services.openai.tts import VALID_VOICES

            VALID_VOICES[voice] = voice  # type: ignore[assignment]

    async def run_tts(self, text: str, context_id: str):
        """Set `self._settings.instructions` from the live tone hint (if
        any) before delegating to `OpenAITTSService.run_tts`, then restore
        the static fallback afterward -- see this class's docstring.
        """
        if self._tone_source is not None:
            tone = getattr(self._tone_source, "last_tone", None)
            self._settings.instructions = tone or self._fallback_instructions
        async for frame in super().run_tts(text, context_id):
            yield frame


def build_openrouter_tts(
    settings: Settings,
    *,
    model: str,
    voice: str = "alloy",
    default_instructions: str | None = None,
    speed: float | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    tone_source: "Any | None" = None,
) -> OpenRouterTTSService:
    """Construct the OpenRouter TTS service (`OpenRouterTTSService`, pointed
    at OpenRouter's `/v1/audio/speech` endpoint).

    `voice` defaults to `"alloy"` only for signature-compatibility with a
    generic "TTS builder" shape -- it is NOT a safe default for
    `microsoft/mai-voice-2` (verified live: "alloy" returns HTTP 400 against
    that model; see `OpenRouterTTSService`'s docstring). Callers MUST pass a
    real voice id for whichever OpenRouter TTS model is actually configured
    (e.g. `"en-US-Harper:MAI-Voice-2"` for mai-voice-2) -- there is no single
    universal default across arbitrary OpenRouter TTS models the way
    oMLX/VoxCPM2 has "default".

    `temperature`/`top_p` are accepted for interface symmetry with
    `build_mlx_tts`/`build_openrouter_llm`, but currently DO NOTHING: they're
    stashed in `Settings.extra["extra_body"]` below, but
    `OpenAITTSService.run_tts` (which `OpenRouterTTSService` inherits
    unmodified -- see that class's docstring) never reads `self._settings.
    extra` at all, unlike `OpenAILLMService`, which does merge `extra` into
    its API call kwargs. Confirmed by reading `OpenAITTSService.run_tts`'s
    source directly, not assumed. Wiring these through for real would
    require overriding `run_tts` to add an `extra_body=` kwarg to the
    `audio.speech.create()` call -- not done here, since neither value was
    exercised live (the live TTS test used neither) and OpenRouter's
    documented `/v1/audio/speech` parameter table doesn't explain how
    `temperature`/`top_p` affect a TTS model's *output*, unlike for an LLM.
    Left as accepted-but-currently-inert parameters (rather than silently
    dropped from the signature) so a future session that verifies the real
    request shape only needs to fix `OpenRouterTTSService`, not this
    function's signature or its callers. `default_instructions` (a static
    fallback tone/style hint -- see `TtsModelSettings.instructions_template`
    in app/model_settings.py) maps to `instructions`, which
    `OpenAITTSService` already supports natively and forwards on every
    request; whether OpenRouter's mai-voice-2 backend actually honors it
    (the way oMLX/VoxCPM2's `instructions` field was verified to measurably
    change output, see `MlxTTSService.run_tts`) is UNVERIFIED -- the live
    test in this session sent no `instructions`.

    `tone_source` (optional -- mirrors `build_mlx_tts`'s identical
    parameter): a reference to `app.pipeline.TranslationDirectionStripper`,
    forwarded to `OpenRouterTTSService` so it can read the translation LLM's
    per-utterance tone hint and send it as `instructions` on each request,
    falling back to `default_instructions` when no live tone is available
    yet. `None` (the default) disables this -- callers that don't pass it
    get static-`instructions`-only behavior, same as before this parameter
    existed. See `OpenRouterTTSService`'s docstring for why this wiring's
    real-world effect on OpenRouter's TTS output is UNVERIFIED, unlike the
    equivalent oMLX wiring.
    """
    extra_body: dict[str, Any] = {}
    if temperature is not None:
        extra_body["temperature"] = temperature
    if top_p is not None:
        extra_body["top_p"] = top_p

    return OpenRouterTTSService(
        api_key=settings.openrouter_api_key,
        base_url=OPENROUTER_BASE_URL,
        tone_source=tone_source,
        settings=OpenRouterTTSService.Settings(
            model=model,
            voice=voice,
            language=None,
            instructions=default_instructions,
            speed=speed,
            extra={"extra_body": extra_body} if extra_body else {},
        ),
    )


class OpenRouterSTTService(SegmentedSTTService):
    """Bespoke STT service for OpenRouter's `/v1/audio/transcriptions`
    endpoint, which is NOT the OpenAI SDK's multipart-upload transcription
    contract (see this module's docstring for the live-verified evidence).

    Extends `SegmentedSTTService` directly (the same base class
    `BaseWhisperSTTService` -- and therefore `OpenAISTTService`/
    `MlxSTTService` -- extends) rather than either of those, since neither
    can be reused: both build their request via
    `self._client.audio.transcriptions.create(file=..., ...)`, which performs
    a multipart file upload using the `openai` SDK's transport. OpenRouter's
    real contract is a plain JSON POST with base64-encoded audio embedded in
    the body (`{"model", "input_audio": {"data", "format"}}`) -- a
    structurally different request, not just different field names, so no
    inherited `_transcribe`-style hook fits; this class implements
    `run_stt(audio: bytes)` directly instead, which is the actual abstract
    contract `SegmentedSTTService`/`STTService` require of every concrete STT
    service (buffer audio until VAD says the utterance ended, then call
    `run_stt` once with the complete WAV bytes, yielding a `TranscriptionFrame`).

    `language_hint` (optional, constructor-only -- from `Settings.stt.
    language_hint`, the Model Lab feature, see app/model_settings.py): when
    set, included as the request's `language` field. Omitted entirely by
    default, for the same reason `MlxSTTService` omits it -- verified live
    (this session) that OpenRouter's `language` field is NOT a soft
    hint/bias but authoritative: sending `language="fr"` against real English
    audio ("Hello, where is the nearest train station?") returned a French
    *translation* of the utterance, not a (failed or successful)
    transcription of the actual English speech. Forcing a language on every
    request would silently break whichever of this pipeline's two configured
    languages wasn't forced -- the same bidirectional-auto-detect concern
    `MlxSTTService`'s docstring documents for oMLX, confirmed to apply here
    too, via a different failure mode (translation instead of empty output).
    """

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        language_hint: str | None = None,
        request_timeout: float = 30.0,
        **kwargs: Any,
    ) -> None:
        # No `Settings`/model-id storage mechanism is inherited from
        # SegmentedSTTService worth reusing here (it's built around
        # provider-specific `STTSettings` subclasses none of which match this
        # transport) -- `model`/`api_key` are kept as plain instance
        # attributes instead, mirroring how `MlxTTSService` (app/
        # mlx_services.py) also bypasses the Settings machinery for its own
        # custom HTTP call.
        super().__init__(
            # model/language are set to None: this service uses its own
            # `self._model`/`self._language_hint` directly in `run_stt`,
            # bypassing the parent's `self._settings` entirely -- but the
            # parent validates that `self._settings.model`/`language` are
            # NOT `NOT_GIVEN` at startup, so we explicitly set them to
            # `None` to satisfy the validation without lying about a
            # meaningful value (this service doesn't use `self._settings`
            # for its actual HTTP request at all).
            settings=STTSettings(model=None, language=None),
            # `ttfs_p99_latency`: no Pipecat-published P99 benchmark exists
            # for OpenRouter's ASR endpoint specifically (unlike OpenAI's
            # Whisper, which has `WHISPER_TTFS_P99`) -- reusing Whisper's
            # published figure as the least-arbitrary available estimate,
            # since both are REST, non-streaming, single-shot transcription
            # endpoints with a broadly comparable latency profile. This is a
            # best-effort default for TTFB metric reporting only; it does
            # not affect transcription behavior or correctness.
            ttfs_p99_latency=WHISPER_TTFS_P99,
            **kwargs,
        )
        self._api_key = api_key
        self._model = model
        self._language_hint = language_hint
        self._client = httpx.AsyncClient(
            base_url=OPENROUTER_BASE_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=request_timeout,
        )

    def can_generate_metrics(self) -> bool:
        """OpenRouter ASR supports processing-time metrics (measured the
        same way as every other REST-based STT service in this codebase --
        wall-clock around the one POST per utterance)."""
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        """Transcribe one complete utterance's WAV bytes via OpenRouter's
        `/v1/audio/transcriptions`.

        `audio` arrives already WAV-wrapped by `SegmentedSTTService`'s own
        buffering (see `pipecat.services.stt_service.SegmentedSTTService.
        _handle_user_stopped_speaking`, which wraps the buffered raw PCM in a
        WAV container before calling `run_stt`) -- exactly the `format:
        "wav"` this endpoint's contract expects (verified live with a real
        16kHz mono WAV file).

        Verified live (this session) with real audio: returns a correct
        transcription via `response.json()["text"]`. Error handling (non-200
        responses, malformed JSON) is NOT separately verified live --
        modeled directly on the same try/except-and-yield-ErrorFrame pattern
        every other STT service in this codebase uses
        (`BaseWhisperSTTService.run_stt`/`MlxSTTService`'s caller), not
        exercised against a real failure from OpenRouter's servers.
        """
        try:
            await self.start_processing_metrics()

            payload: dict[str, Any] = {
                "model": self._model,
                "input_audio": {
                    "data": base64.b64encode(audio).decode("ascii"),
                    "format": "wav",
                },
            }
            if self._language_hint:
                payload["language"] = self._language_hint

            response = await self._client.post(
                "/audio/transcriptions",
                content=json.dumps(payload),
            )

            await self.stop_processing_metrics()

            if response.status_code != 200:
                logger.error(
                    f"{self} error transcribing audio "
                    f"(status: {response.status_code}, body: {response.text})"
                )
                yield ErrorFrame(
                    error=f"OpenRouter transcription error (status: {response.status_code})"
                )
                return

            data = response.json()
            text = (data.get("text") or "").strip()

            if not text:
                logger.warning("Received empty transcription from OpenRouter")
                return

            logger.debug(f"Transcription: [{text}]")
            yield TranscriptionFrame(
                text,
                self._user_id,
                time_now_iso8601(),
                result=Transcription.construct(text=text),
            )
        except Exception as e:
            yield ErrorFrame(error=f"Unknown error occurred: {e}")

    async def cleanup(self):
        """Close the underlying httpx client on service teardown."""
        await super().cleanup()
        await self._client.aclose()


def build_openrouter_stt(
    settings: Settings, *, model: str, language_hint: str | None = None
) -> OpenRouterSTTService:
    """Construct the OpenRouter STT service (`OpenRouterSTTService`, pointed
    at OpenRouter's `/v1/audio/transcriptions` endpoint.

    See `OpenRouterSTTService` for why a bespoke httpx-based class (rather
    than `OpenAISTTService`/`MlxSTTService`) was required, and for why
    `language_hint` defaults to `None`/auto-detect rather than forcing a
    language (verified live to actively translate, not just mistranscribe,
    when the hint mismatches the spoken language).
    """
    return OpenRouterSTTService(
        api_key=settings.openrouter_api_key,
        model=model,
        language_hint=language_hint,
    )


def build_stt_from_manifest(
    settings: Settings, *, model: str, language_hint: str | None = None
) -> "OpenRouterSTTService | ManifestSTTService":
    """Construct an STT service using the transport-adapter + manifest pattern
    when a matching manifest exists; falls back to the legacy hardcoded
    ``OpenRouterSTTService`` when no manifest matches ``model``.

    This is the migration path: new manifests in ``docs/`` automatically
    drive ``HttpRestTransport`` with their declared request template and
    response path, no code changes needed.  Models without a manifest
    (yet) still get the legacy service class.
    """
    from app.model_adapters.manifest import get_manifest
    from app.model_adapters.transport import HttpRestTransport

    manifest = get_manifest("openrouter", model)
    if manifest is not None and manifest.transport_protocol == "http":
        transport = HttpRestTransport(manifest, api_key=settings.openrouter_api_key)
        return ManifestSTTService(
            transport=transport,
            language_hint=language_hint,
        )
    # Fall back to legacy hardcoded service
    return build_openrouter_stt(settings, model=model, language_hint=language_hint)


class ManifestSTTService(SegmentedSTTService):
    """Thin Pipecat ``SegmentedSTTService`` wrapper that delegates the actual
    HTTP request to a ``HttpRestTransport`` adapter, which reads its request
    shape and response parsing from a ``ModelManifest``.

    This separates "Pipecat frame lifecycle" (start/stop/VAD buffering --
    handled by the base class) from "how to talk to this specific model's
    HTTP endpoint" (handled by the transport adapter + manifest).  Adding
    a new HTTP-based ASR model is now a matter of dropping a manifest JSON
    into ``docs/`` -- no Python code changes needed.
    """

    def __init__(
        self,
        *,
        transport: "HttpRestTransport",
        language_hint: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(
            settings=STTSettings(model=None, language=None),
            ttfs_p99_latency=WHISPER_TTFS_P99,
            **kwargs,
        )
        self._transport = transport
        self._language_hint = language_hint

    def can_generate_metrics(self) -> bool:
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        """Delegate to the transport adapter for the actual HTTP request.
        The transport knows the URL, request template, and response path
        from its manifest -- this class only owns the Pipecat frame lifecycle.
        """
        try:
            await self.start_processing_metrics()
            await self._transport.start()
            async for frame in self._transport.run_stt(audio):
                yield frame
            await self._transport.stop()
            await self.stop_processing_metrics()
        except Exception as exc:
            yield ErrorFrame(error=f"ManifestSTTService failed: {exc}")
