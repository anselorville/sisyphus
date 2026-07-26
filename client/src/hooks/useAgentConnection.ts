import { useCallback, useEffect, useRef, useState } from "react";
import { getServerAddress, setServerAddress as persistServerAddress } from "../settings/serverAddress";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const PING_INTERVAL_MS = 3000;

// Host/LAN candidates (what this local-first product actually connects
// over -- client and server are always on the same machine or same LAN)
// gather in milliseconds; full ICE gathering also waits on the STUN (srflx)
// candidate, which can hang far longer, or never resolve at all offline.
// Without a timeout an unreachable STUN server silently hangs connect()
// before the SDP offer is ever sent. See useTranslatorConnection.ts (the
// hook this one is generalized from) for the same constant and rationale.
const ICE_GATHERING_TIMEOUT_MS = 2000;

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Shape of GET /api/status (see app/server.py) -- the Python media plane's own health, independent of the agent-runtime sidecar (see AgentRuntimeStatus below for that). No language-pair fields: the server itself no longer takes a per-connection language pair or mode. */
export interface AgentServerStatus {
  readonly product: string;
  readonly stt_provider: string;
  readonly tts_provider: string;
  /** "manual": mic button owns turn boundaries; "auto": hands-free VAD turns. */
  readonly turn_mode?: "manual" | "auto";
}

/**
 * ============================================================================
 * DOCUMENTED WIRE-SHAPE EXTENSION -- browser <-> Python data channel
 * ============================================================================
 * The browser and app/server.py already share one WebRTC data channel named
 * "transcript" (see the `pc.createDataChannel("transcript")` call below --
 * kept as-is; renaming it would be a Python-side wire change too, out of
 * scope here) carrying newline-free JSON text messages tagged by a `type`
 * field, e.g. today's `{"type":"mic","open":true}`.
 *
 * IMPORTANT KNOWN GAP (see this task's own brief): nothing on the Python
 * side forwards the TypeScript agent-runtime sidecar's RealtimeEvent stream
 * (agent-runtime/src/protocol/events.ts's `RealtimeEventType` union) onto
 * this channel yet. The shapes below are this hook's (and useAgentTasks's /
 * useEcologyStatus's) DOCUMENTED, but not yet backend-wired, EXPECTED wire
 * format -- the concrete target for whichever future task builds that
 * Python-side forwarder. Designed so that forwarder's job is as close to
 * "pass the sidecar's own RealtimeEvent.type straight through, lift a
 * handful of payload fields to the top level" as possible:
 *
 *   - `type` is always IDENTICAL to the sidecar's own RealtimeEventType
 *     string (e.g. "task.completed", "ecology.state.changed") wherever a
 *     direct mapping exists -- never renamed/reshaped for the browser.
 *   - `task_id`/`timestamp` come straight from the sidecar's RealtimeEvent
 *     envelope (event_id/sequence/source/interaction_id are sidecar-internal
 *     bookkeeping this UI never needs and are deliberately NOT forwarded).
 *   - Payload fields are exactly the small set Voice Herald
 *     (agent-runtime/src/voice/voice-herald.ts) already treats as
 *     meaningful for that event type (`text`/`summary`/`reason`/`action`/
 *     `impact`/`state`) -- never a raw, un-vetted payload dump. This mirrors
 *     the backend's own content-safety principle: chain-of-thought, raw tool
 *     logs, and JSON/debug content must never reach user-facing surfaces,
 *     spoken OR displayed.
 *
 * Task lifecycle (-> useAgentTasks.ts's AgentTaskWireEvent):
 *   {"type":"task.created",   "task_id":str, "timestamp":iso, "goal":str}
 *   {"type":"task.assigned",  "task_id":str, "timestamp":iso, "role_id"?:str}
 *   {"type":"task.progress",  "task_id":str, "timestamp":iso, "text"?:str}
 *   {"type":"task.completed", "task_id":str, "timestamp":iso, "summary"?:str}
 *   {"type":"task.failed",    "task_id":str, "timestamp":iso, "reason"?:str}
 *   {"type":"task.cancelled", "task_id":str, "timestamp":iso}
 *
 * Ecology / budget (-> useEcologyStatus.ts's EcologyWireEvent):
 *   {"type":"ecology.state.changed", "state":FoodBand, "timestamp":iso}
 *   {"type":"budget.updated",        "state":FoodBand, "timestamp":iso}
 *   (FoodBand = "prosperous"|"conserving"|"reserve"|"hibernating", see
 *   agent-runtime/src/economy/types.ts's FoodState)
 *
 * Elevation (diplomacy):
 *   {"type":"diplomacy.elevation.requested", "request_id":str,
 *    "task_id"?:str, "action"?:str, "impact"?:str, "timestamp":iso}
 *   {"type":"diplomacy.elevation.resolved",  "request_id":str,
 *    "task_id"?:str, "timestamp":iso}
 *   ("action"/"impact" are the same two fields
 *   agent-runtime/src/tools/capability-gateway.ts's PendingElevationRequest
 *   carries into voice-herald.ts's buildElevationRequestText() template --
 *   "准备执行{action}，可能影响{impact}，是否允许？")
 *
 * Speech (best-effort "is the agent currently speaking" signal -- the
 * sidecar's RealtimeEventType vocabulary has no explicit "playback finished"
 * marker, only enqueue/cancel, so this is necessarily approximate; see
 * isSpeaking below):
 *   {"type":"voice.speech.enqueue", "timestamp":iso}
 *   {"type":"voice.speech.cancel",  "timestamp":iso}
 *
 * Outbound (browser -> Python -> sidecar), sent via sendControl() below:
 *   {"type":"mic", "open":bool}                                  (existing)
 *   {"type":"task.cancel",    "task_id":str}
 *   {"type":"task.steer",     "task_id":str, "text":str}
 *   {"type":"task.follow_up", "task_id":str, "text":str}
 *   {"type":"elevation.response", "request_id":str, "allow":bool}
 * ============================================================================
 */

export interface TaskWireEventBase {
  readonly task_id: string;
  readonly timestamp?: string;
}
export type TaskWireEvent =
  | (TaskWireEventBase & { type: "task.created"; goal: string })
  | (TaskWireEventBase & { type: "task.assigned"; role_id?: string })
  | (TaskWireEventBase & { type: "task.progress"; text?: string })
  | (TaskWireEventBase & { type: "task.completed"; summary?: string })
  | (TaskWireEventBase & { type: "task.failed"; reason?: string })
  | (TaskWireEventBase & { type: "task.cancelled" });

export interface EcologyWireEvent {
  readonly type: "ecology.state.changed" | "budget.updated";
  readonly state: string;
  readonly timestamp?: string;
}

export interface ElevationWireEvent {
  readonly type: "diplomacy.elevation.requested" | "diplomacy.elevation.resolved";
  readonly request_id: string;
  readonly task_id?: string;
  readonly action?: string;
  readonly impact?: string;
  readonly timestamp?: string;
}

export interface SpeechWireEvent {
  readonly type: "voice.speech.enqueue" | "voice.speech.cancel";
  readonly timestamp?: string;
}

export type AgentWireEvent = TaskWireEvent | EcologyWireEvent | ElevationWireEvent | SpeechWireEvent;

/** Outbound control messages this hook can send -- see sendControl() below. */
export type AgentControlMessage =
  | { readonly type: "task.cancel"; readonly task_id: string }
  | { readonly type: "task.steer"; readonly task_id: string; readonly text: string }
  | { readonly type: "task.follow_up"; readonly task_id: string; readonly text: string }
  | { readonly type: "elevation.response"; readonly request_id: string; readonly allow: boolean };

const AGENT_WIRE_EVENT_TYPES = new Set<string>([
  "task.created",
  "task.assigned",
  "task.progress",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "ecology.state.changed",
  "budget.updated",
  "diplomacy.elevation.requested",
  "diplomacy.elevation.resolved",
  "voice.speech.enqueue",
  "voice.speech.cancel",
]);

function parseAgentWireEvent(raw: string): AgentWireEvent | null {
  if (raw === "ping" || raw === "pong") return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const { type } = msg as Record<string, unknown>;
  if (typeof type !== "string" || !AGENT_WIRE_EVENT_TYPES.has(type)) return null;
  return msg as AgentWireEvent;
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export interface UseAgentConnectionResult {
  connectionState: ConnectionState;
  serverAddress: string;
  setServerAddress: (value: string) => void;
  localStream: MediaStream | null;
  serverStatus: AgentServerStatus | null;
  /** Opens the WebRTC session and POSTs the SDP offer to /api/offer. No language pair or mode -- the server itself no longer takes either (see AgentServerStatus's doc comment). */
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Manual turn mode: whether the mic is currently open (voice input flowing). */
  micOpen: boolean;
  /** Manual turn mode: open/close the mic; also notifies the server over the data channel ({"type":"mic","open":...}). No-op unless connected. */
  setMicOpen: (open: boolean) => void;
  /**
   * Most recently received recognized realtime event, or `null` before the
   * first one arrives this session. A fresh object every time (even for
   * back-to-back messages with identical content), so a consumer effect
   * keyed on this value fires once per message, including duplicates --
   * deduplication is the reducer's job (see useAgentTasks.ts/
   * useEcologyStatus.ts), not the transport's.
   */
  lastEvent: AgentWireEvent | null;
  /** Best-effort "the agent is currently speaking" signal -- see the SpeechWireEvent doc comment above for why this is approximate. */
  isSpeaking: boolean;
  /** Sends a control message to the sidecar over the data channel. No-op if not connected. */
  sendControl: (message: AgentControlMessage) => void;
}

export function useAgentConnection(): UseAgentConnectionResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [serverAddress, setServerAddressState] = useState<string>(() => getServerAddress());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [serverStatus, setServerStatus] = useState<AgentServerStatus | null>(null);
  const [micOpen, setMicOpenState] = useState(false);
  const [lastEvent, setLastEvent] = useState<AgentWireEvent | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // "manual" unless the server explicitly says "auto" -- matches the
  // server-side default (app/config.py TURN_MODE) and errs toward the safer
  // mode (closed mic) if /api/status hasn't loaded yet.
  const manualTurnMode = serverStatus?.turn_mode !== "auto";
  const manualTurnModeRef = useRef(manualTurnMode);
  manualTurnModeRef.current = manualTurnMode;

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const teardown = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setLocalStream((prev) => {
      prev?.getTracks().forEach((track) => track.stop());
      return null;
    });
    setMicOpenState(false);
    setIsSpeaking(false);
  }, []);

  const connect = useCallback(async () => {
    if (pcRef.current) return;
    setConnectionState("connecting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setConnectionState("error");
      return;
    }
    // Manual turn mode: the mic starts CLOSED -- the track stays live (so
    // WebRTC keeps sending silence and the server-side STT connection stays
    // warm) but disabled, and the user must open a turn explicitly. Auto
    // mode keeps the original always-hot mic.
    if (manualTurnModeRef.current) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    }
    setLocalStream(stream);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.ontrack = (event) => {
      if (!remoteAudioRef.current) {
        remoteAudioRef.current = new Audio();
        remoteAudioRef.current.autoplay = true;
      }
      remoteAudioRef.current.srcObject = event.streams[0];
      remoteAudioRef.current.play().catch(() => {});
    };

    const dataChannel = pc.createDataChannel("transcript");
    dataChannelRef.current = dataChannel;

    dataChannel.onopen = () => {
      pingIntervalRef.current = setInterval(() => {
        if (dataChannel.readyState === "open") dataChannel.send("ping");
      }, PING_INTERVAL_MS);
    };
    dataChannel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const parsed = parseAgentWireEvent(event.data);
      if (!parsed) return;
      setLastEvent(parsed);
      if (parsed.type === "voice.speech.enqueue") setIsSpeaking(true);
      else if (parsed.type === "voice.speech.cancel") setIsSpeaking(false);
    };

    pc.onconnectionstatechange = () => {
      const state = pcRef.current?.connectionState;
      if (state === "connected") setConnectionState("connected");
      else if (state === "failed" || state === "closed" || state === "disconnected") {
        setConnectionState("disconnected");
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    try {
      const response = await fetch(`${serverAddress}/api/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdp: pc.localDescription!.sdp,
          type: pc.localDescription!.type,
        }),
      });
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      const answer = await response.json();
      await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
    } catch {
      teardown();
      setConnectionState("error");
    }
  }, [serverAddress, teardown]);

  const disconnect = useCallback(() => {
    teardown();
    setConnectionState("disconnected");
  }, [teardown]);

  const setMicOpen = useCallback((open: boolean) => {
    const dataChannel = dataChannelRef.current;
    if (!pcRef.current || !dataChannel || dataChannel.readyState !== "open") return;
    setLocalStream((stream) => {
      stream?.getAudioTracks().forEach((track) => {
        track.enabled = open;
      });
      return stream;
    });
    dataChannel.send(JSON.stringify({ type: "mic", open }));
    setMicOpenState(open);
  }, []);

  const sendControl = useCallback((message: AgentControlMessage) => {
    const dataChannel = dataChannelRef.current;
    if (!dataChannel || dataChannel.readyState !== "open") return;
    dataChannel.send(JSON.stringify(message));
  }, []);

  const setServerAddress = useCallback((value: string) => {
    setServerAddressState(value);
    persistServerAddress(value);
  }, []);

  useEffect(() => teardown, [teardown]);

  // Fetch the media plane's own health (STT/TTS providers, turn mode) so the
  // UI reflects reality instead of a hardcoded guess. Re-fetched whenever
  // serverAddress changes so pointing the client at a different server picks
  // up that server's status.
  useEffect(() => {
    let cancelled = false;
    fetch(`${serverAddress}/api/status`)
      .then((response) => {
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        return response.json();
      })
      .then((data: AgentServerStatus) => {
        if (!cancelled) setServerStatus(data);
      })
      .catch(() => {
        if (!cancelled) setServerStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [serverAddress]);

  return {
    connectionState,
    serverAddress,
    setServerAddress,
    localStream,
    serverStatus,
    connect,
    disconnect,
    micOpen,
    setMicOpen,
    lastEvent,
    isSpeaking,
    sendControl,
  };
}
