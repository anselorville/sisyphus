# Pipeline Latency Phase 1 Design

## Objective

Reduce the perceived delay between the user finishing an utterance and the
translated audio beginning, without changing providers, replacing Pipecat, or
adding new speech models. Make the latency measurable and preserve the existing
sentence-fragment protection and barge-in behavior.

## Current State

The pipeline already uses `SileroVADAnalyzer` through the Pipecat user
aggregator and enables interruptions through both VAD- and
transcription-based user-turn start strategies.

After STT, `SemanticBufferProcessor` adds a second completion policy. It sends
text immediately when terminal punctuation is present, but otherwise waits for
a fixed three-second timer. That timer is inside the user-perceived silence
window and can dominate STT, LLM, and TTS latency for unpunctuated final
transcripts.

`PipelineParams` enables Pipecat metrics, but no user-to-bot latency observer is
registered. Consequently the application cannot report the end-to-end delay or
its service-level breakdown.

## Selected Approach

Keep `SemanticBufferProcessor`, but make it turn-aware and reduce its fallback
timeout to 500 milliseconds.

The alternatives were rejected for this phase:

- Removing semantic buffering entirely risks translating provider-specific
  final fragments as separate sentences.
- Only changing the numeric timeout leaves the buffer unaware of explicit turn
  boundaries and retains unnecessary waits when the turn has already ended.

## Semantic Buffer Behavior

The processor continues to consume final `TranscriptionFrame` objects and pass
all unrelated frames through unchanged.

It follows these rules:

1. Accumulate transcription text in arrival order.
2. When accumulated text contains terminal punctuation, immediately emit all
   complete sentences and retain only the incomplete suffix.
3. When a Pipecat user-stopped-speaking frame arrives, immediately emit any
   buffered suffix before forwarding the stop frame.
4. When no explicit boundary arrives, emit the buffered suffix after 500ms of
   inactivity.
5. A new transcription fragment replaces the existing fallback timer.
6. End, cancel, and cleanup paths cancel the timer and must not allow delayed
   text to leak into a later turn.

The 500ms value is a named application constant and is passed explicitly when
the pipeline is built. This makes the latency budget visible and avoids hiding
product behavior in the processor constructor.

## Latency Observability

Create one Pipecat `UserBotLatencyObserver` per pipeline worker and attach it to
the worker. Register handlers that log:

- user-to-bot latency in seconds;
- first-bot-speech latency in seconds;
- the detailed latency breakdown when Pipecat emits one.

Metrics remain enabled through `PipelineParams`. Observer registration must be
kept in a small builder function so it can be tested without constructing a
real WebRTC connection or contacting providers.

The first phase logs structured measurements through Loguru. It does not add a
database, telemetry backend, API endpoint, or frontend chart.

## Barge-In Scope

Existing VAD- and transcription-based interruption strategies remain unchanged.
This phase adds a documented live acceptance procedure covering:

1. Start a long translated response.
2. Speak while translated audio is playing.
3. Confirm audible output stops promptly.
4. Confirm the new utterance produces one translation.
5. Confirm no audio from the cancelled response resumes afterward.

Automated tests cover timer cancellation and stale semantic-buffer output. A
real microphone, provider, WebRTC sender, and browser playout buffer are needed
to validate the complete audible interruption path, so the document will not
claim that unit tests prove end-to-end barge-in.

## Error Handling

- Empty or whitespace-only buffered text is discarded.
- Timer cancellation is expected control flow and produces no error log.
- Observer callbacks must not mutate pipeline state; they only log data.
- A missing detailed breakdown event does not affect the pipeline because
  basic user-to-bot latency remains independently observable.

## Testing

Unit tests for `SemanticBufferProcessor` prove:

- terminal punctuation flushes immediately;
- unpunctuated text flushes after the configured short timeout;
- a user-stopped-speaking frame flushes immediately;
- multiple fragments are joined correctly;
- replacement timers do not emit duplicate text;
- cancellation/cleanup prevents delayed stale output.

Unit tests for the latency observer builder prove:

- it returns a `UserBotLatencyObserver`;
- all required event handlers are registered;
- callbacks accept representative latency and breakdown events without
  changing pipeline state.

The full Python test suite is the regression gate. The live barge-in checklist
is a separate manual acceptance gate.

## Success Criteria

- The semantic fallback delay is at most 500ms instead of 3s.
- Explicit user-turn stop flushes buffered transcription without waiting for
  the fallback timer.
- User-to-bot and first-speech latency are emitted to application logs.
- Existing provider selection, translation direction, WebRTC transport, and
  interruption configuration remain unchanged.
- All automated tests pass.

## Out of Scope

- Migrating away from Pipecat.
- Adding Hugging Face Parakeet, Pocket TTS, Kokoro, or Qwen3-TTS adapters.
- Replacing WebRTC with the OpenAI Realtime WebSocket protocol.
- Changing STT, LLM, or TTS providers and models.
- Adding persistent metrics storage or a latency UI.
