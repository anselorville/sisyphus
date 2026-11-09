import { describe, expect, it } from "vitest";
import {
  INITIAL_VOICE_SESSION,
  deriveVoicePhase,
  reduceVoiceSession,
  type VoiceSessionAction,
  type VoiceSessionState,
} from "./useVoiceSession";

function run(actions: VoiceSessionAction[], from: VoiceSessionState = INITIAL_VOICE_SESSION): VoiceSessionState {
  return actions.reduce(reduceVoiceSession, from);
}

function phase(session: VoiceSessionState, micOpen = false) {
  return deriveVoicePhase({ connectionState: "connected", micOpen, session });
}

describe("reduceVoiceSession", () => {
  it("walks a normal turn: listening, thinking, speaking, ready", () => {
    let state = run([{ type: "voice.user.started" }, { type: "voice.transcript.partial", text: "明天天气" }]);
    expect(phase(state)).toBe("listening");
    expect(state.partialText).toBe("明天天气");

    state = run([{ type: "voice.user.stopped" }], state);
    expect(phase(state)).toBe("thinking");

    state = run([{ type: "user.transcript", text: "明天天气怎么样" }], state);
    expect(state.partialText).toBe("");
    expect(phase(state)).toBe("thinking");

    state = run([{ type: "voice.agent.started" }], state);
    expect(phase(state)).toBe("speaking");
    expect(state.awaitingReply).toBe(false);

    state = run([{ type: "voice.agent.stopped" }], state);
    expect(phase(state)).toBe("ready");
  });

  it("does not wait for a reply after a turn with nothing recognized", () => {
    const state = run([{ type: "voice.user.started" }, { type: "voice.user.stopped" }]);
    expect(state.awaitingReply).toBe(false);
    expect(phase(state)).toBe("ready");
  });

  it("starts waiting on the final transcript when the STT sends no partials", () => {
    const state = run([
      { type: "voice.user.started" },
      { type: "voice.user.stopped" },
      { type: "user.transcript", text: "你好" },
    ]);
    expect(phase(state)).toBe("thinking");
  });

  it("ignores blank partials", () => {
    const state = run([{ type: "voice.user.started" }, { type: "voice.transcript.partial", text: "  " }]);
    expect(state.heardInTurn).toBe(false);
    expect(state.partialText).toBe("");
  });

  it("leaves speaking on barge-in and opens a fresh user turn", () => {
    const state = run([
      { type: "voice.agent.started" },
      { type: "voice.speech.cancel", reason: "barge_in" },
      { type: "voice.user.started" },
    ]);
    expect(state.agentSpeaking).toBe(false);
    expect(phase(state)).toBe("listening");
  });

  it("does not wait when a final arrives while the agent is already talking", () => {
    const state = run([{ type: "voice.agent.started" }, { type: "user.transcript", text: "嗯" }]);
    expect(state.awaitingReply).toBe(false);
  });

  it("expires a reply that never came", () => {
    const waiting = run([{ type: "voice.user.started" }, { type: "user.transcript", text: "x" }, { type: "voice.user.stopped" }]);
    expect(waiting.awaitingReply).toBe(true);
    expect(run([{ type: "reply.expired" }], waiting).awaitingReply).toBe(false);
  });

  it("resets everything when the session ends", () => {
    const busy = run([{ type: "voice.user.started" }, { type: "voice.agent.started" }]);
    expect(run([{ type: "session.reset" }], busy)).toEqual(INITIAL_VOICE_SESSION);
  });

  it("returns the same object for events it does not handle", () => {
    const state = run([{ type: "voice.agent.started" }]);
    expect(reduceVoiceSession(state, { type: "task.cancelled", task_id: "t" })).toBe(state);
    expect(reduceVoiceSession(INITIAL_VOICE_SESSION, { type: "voice.agent.stopped" })).toBe(INITIAL_VOICE_SESSION);
  });
});

describe("deriveVoicePhase", () => {
  it("lets the connection state win while not connected", () => {
    const busy = run([{ type: "voice.agent.started" }]);
    expect(deriveVoicePhase({ connectionState: "disconnected", micOpen: false, session: busy })).toBe("offline");
    expect(deriveVoicePhase({ connectionState: "connecting", micOpen: false, session: busy })).toBe("connecting");
    expect(deriveVoicePhase({ connectionState: "error", micOpen: false, session: busy })).toBe("error");
  });

  it("treats an open manual mic as listening even before speech is detected", () => {
    expect(phase(INITIAL_VOICE_SESSION, true)).toBe("listening");
  });

  it("puts speaking above listening", () => {
    const state = run([{ type: "voice.user.started" }, { type: "voice.agent.started" }]);
    expect(phase(state, true)).toBe("speaking");
  });
});

describe("recorded live session", () => {
  // Browser-bound events captured from a real call (scripts/voice-smoke.py
  // --barge-in against the full stack), task events trimmed. The phase after
  // each event is what the UI shows.
  const timeline: [VoiceSessionAction, ReturnType<typeof deriveVoicePhase>][] = [
    [{ type: "voice.user.started" }, "listening"],
    [{ type: "voice.transcript.partial", text: "请详细介绍一下。" }, "listening"],
    [{ type: "voice.user.stopped" }, "thinking"],
    [{ type: "voice.transcript.partial", text: "请详细介绍一下你自己能做什么。" }, "thinking"],
    [{ type: "user.transcript", text: "请详细介绍一下你自己能做什么。" }, "thinking"],
    [{ type: "agent.transcript", text: "嗯，详细介绍自己能做，我确认一下。" }, "thinking"],
    [{ type: "voice.agent.started" }, "speaking"],
    [{ type: "agent.transcript", text: "我主要做三件事……" }, "speaking"],
    [{ type: "voice.speech.cancel", reason: "barge_in" }, "ready"],
    [{ type: "voice.user.started" }, "listening"],
    [{ type: "voice.agent.stopped" }, "listening"],
    [{ type: "voice.transcript.partial", text: "请详细介绍一下你自己能。" }, "listening"],
    [{ type: "voice.user.stopped" }, "thinking"],
    [{ type: "user.transcript", text: "请详细介绍一下你自己能做什么。" }, "thinking"],
    [{ type: "voice.agent.started" }, "speaking"],
    // Between two sentences the transport ends and restarts the turn in the same tick.
    [{ type: "voice.agent.stopped" }, "ready"],
    [{ type: "voice.agent.started" }, "speaking"],
    [{ type: "voice.agent.stopped" }, "ready"],
  ];

  it("shows the expected phase after every event", () => {
    let state = INITIAL_VOICE_SESSION;
    const phases = timeline.map(([action]) => {
      state = reduceVoiceSession(state, action);
      return phase(state);
    });
    expect(phases).toEqual(timeline.map(([, expected]) => expected));
  });
});
