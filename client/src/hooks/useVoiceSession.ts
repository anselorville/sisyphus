import { useCallback, useEffect, useReducer } from "react";
import type { AgentWireEvent, ConnectionState } from "./useAgentConnection";

/**
 * Turn-taking state of the live conversation, folded from the media plane's
 * voice events (see app/realtime/browser_wire.py) plus the final transcript
 * echoes. Connection and mic state stay in useAgentConnection; derive the
 * single phase to show with `deriveVoicePhase`.
 */
export interface VoiceSessionState {
  /** The user's turn is open (VAD start, or the manual mic was opened). */
  readonly userSpeaking: boolean;
  /** Interim STT text for the current user turn; "" when there is none. */
  readonly partialText: string;
  /** Speech was recognized in the current turn (a partial or a final arrived). */
  readonly heardInTurn: boolean;
  /** The user finished a turn with recognized speech and the agent hasn't started answering. */
  readonly awaitingReply: boolean;
  /** The agent's audio is playing right now. */
  readonly agentSpeaking: boolean;
}

export const INITIAL_VOICE_SESSION: VoiceSessionState = {
  userSpeaking: false,
  partialText: "",
  heardInTurn: false,
  awaitingReply: false,
  agentSpeaking: false,
};

/** Local actions: the call ended, or a reply never came (see REPLY_TIMEOUT_MS). */
export type VoiceSessionLocalAction = { readonly type: "session.reset" } | { readonly type: "reply.expired" };

export type VoiceSessionAction = AgentWireEvent | VoiceSessionLocalAction;

export function reduceVoiceSession(state: VoiceSessionState, action: VoiceSessionAction): VoiceSessionState {
  switch (action.type) {
    case "voice.user.started":
      return { ...state, userSpeaking: true, partialText: "", heardInTurn: false, awaitingReply: false };
    case "voice.transcript.partial": {
      const text = action.text?.trim() ?? "";
      if (!text) return state;
      return { ...state, partialText: text, heardInTurn: true };
    }
    case "voice.user.stopped":
      // A turn with nothing recognized (an accidental mic tap, noise) gets
      // no reply, so it must not leave the UI waiting for one. Without
      // partials, the final transcript below still starts the wait.
      return {
        ...state,
        userSpeaking: false,
        awaitingReply: state.awaitingReply || state.heardInTurn,
        partialText: state.heardInTurn ? state.partialText : "",
      };
    case "user.transcript":
      // The final text replaces the partial in the transcript list.
      return {
        ...state,
        partialText: "",
        heardInTurn: true,
        awaitingReply: !state.agentSpeaking && !state.userSpeaking,
      };
    case "voice.agent.started":
      return { ...state, agentSpeaking: true, awaitingReply: false };
    case "voice.agent.stopped":
    case "voice.speech.cancel":
      return state.agentSpeaking ? { ...state, agentSpeaking: false } : state;
    case "reply.expired":
      return state.awaitingReply ? { ...state, awaitingReply: false } : state;
    case "session.reset":
      return INITIAL_VOICE_SESSION;
    default:
      return state;
  }
}

/** What the conversation is doing right now, in display priority order. */
export type VoicePhase = "offline" | "connecting" | "error" | "ready" | "listening" | "thinking" | "speaking";

export function deriveVoicePhase(input: {
  connectionState: ConnectionState;
  micOpen: boolean;
  session: VoiceSessionState;
}): VoicePhase {
  const { connectionState, micOpen, session } = input;
  if (connectionState === "error") return "error";
  if (connectionState === "connecting") return "connecting";
  if (connectionState !== "connected") return "offline";
  if (session.agentSpeaking) return "speaking";
  if (micOpen || session.userSpeaking) return "listening";
  if (session.awaitingReply) return "thinking";
  return "ready";
}

/**
 * Longest a "thinking" state may last without the agent starting to speak.
 * A turn the agent never answers (dropped by the sidecar, failed task with
 * no narration) would otherwise leave the UI waiting forever.
 */
export const REPLY_TIMEOUT_MS = 30_000;

export interface UseVoiceSessionResult extends VoiceSessionState {
  /** Feed every realtime event here (see useAgentConnection's onEvent). */
  dispatch: (action: VoiceSessionAction) => void;
}

/** Resets when the connection drops and expires a reply that never came. */
export function useVoiceSession(connectionState: ConnectionState): UseVoiceSessionResult {
  const [state, rawDispatch] = useReducer(reduceVoiceSession, INITIAL_VOICE_SESSION);
  const dispatch = useCallback((action: VoiceSessionAction) => rawDispatch(action), []);

  useEffect(() => {
    if (connectionState !== "connected") rawDispatch({ type: "session.reset" });
  }, [connectionState]);

  useEffect(() => {
    if (!state.awaitingReply) return;
    const timer = setTimeout(() => rawDispatch({ type: "reply.expired" }), REPLY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [state.awaitingReply]);

  return { ...state, dispatch };
}
