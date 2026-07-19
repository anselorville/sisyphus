import { useCallback, useEffect, useRef, useState } from "react";
import { getServerAddress, setServerAddress as persistServerAddress } from "../settings/serverAddress";
import type { ConnectionState, ServerStatus, TranscriptEvent } from "./useTranslatorConnection.types";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const PING_INTERVAL_MS = 3000;

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Host/LAN candidates (what this local-first product actually connects
// over -- client and server are always on the same machine or same LAN,
// never traversing a real NAT over the public internet) gather in
// milliseconds. Full ICE gathering completion also waits on the
// STUN-server (srflx) candidate, which can hang far longer than that --
// or never resolve at all on a restrictive/offline network -- and
// "complete" only fires once every candidate type is done. Without a
// timeout, an unreachable STUN server silently hangs the whole connect()
// flow before the SDP offer is ever sent (confirmed live: 8s+ stuck in
// "gathering" with working host candidates already available). 2 seconds
// is generous for host candidates and short enough not to make a real
// offline session feel broken.
const ICE_GATHERING_TIMEOUT_MS = 2000;

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

function parseTranscriptMessage(raw: string): TranscriptEvent | null {
  if (raw === "ping") return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const { type, kind, text, direction } = msg as Record<string, unknown>;
  if (type !== "transcript" || typeof text !== "string") return null;

  return kind === "translation"
    ? { kind: "translation", id: makeId(), timestamp: Date.now(), text, direction: direction as string | undefined }
    : { kind: "original", id: makeId(), timestamp: Date.now(), text };
}

export interface UseTranslatorConnectionResult {
  connectionState: ConnectionState;
  transcripts: TranscriptEvent[];
  serverAddress: string;
  setServerAddress: (value: string) => void;
  localStream: MediaStream | null;
  serverStatus: ServerStatus | null;
  /**
   * Open the WebRTC session. `languages` (backend-recognized free-text
   * names, e.g. {source: "Chinese", target: "French"}) and `mode`
   * ("translator" or "assistant") ride in the offer body so the per-
   * connection pipeline matches the UI -- omitted, the server falls back
   * to its .env defaults.
   */
  connect: (languages?: { source: string; target: string; mode?: string }) => Promise<void>;
  disconnect: () => void;
  /** Manual turn mode: whether the mic is currently open (voice input flowing). */
  micOpen: boolean;
  /**
   * Manual turn mode: open/close the mic. Toggles the local audio track AND
   * notifies the server over the data channel ({"type":"mic","open":...}) so
   * the pipeline can start/stop the user turn. No-op unless connected.
   */
  setMicOpen: (open: boolean) => void;
}

export function useTranslatorConnection(): UseTranslatorConnectionResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [transcripts, setTranscripts] = useState<TranscriptEvent[]>([]);
  const [serverAddress, setServerAddressState] = useState<string>(() => getServerAddress());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [micOpen, setMicOpenState] = useState(false);

  // "manual" unless the server explicitly says "auto" -- matches the
  // server-side default (app/config.py TURN_MODE), and errs toward the
  // safer mode (closed mic) if /api/status hasn't loaded yet.
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
  }, []);

  const connect = useCallback(async (languages?: { source: string; target: string; mode?: string }) => {
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
    // warm) but disabled, and the user must press the mic button to open a
    // turn. Auto mode keeps the original always-hot mic.
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
      const entry = parseTranscriptMessage(event.data);
      if (entry) setTranscripts((prev) => [...prev, entry]);
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
          // Language pair and mode for THIS conversation's pipeline (see
          // the offer endpoint in app/server.py); omitted fields fall
          // back to the server's .env defaults.
          ...(languages ? { source_lang: languages.source, target_lang: languages.target } : {}),
          ...(languages?.mode ? { mode: languages.mode } : {}),
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

  const setServerAddress = useCallback((value: string) => {
    setServerAddressState(value);
    persistServerAddress(value);
  }, []);

  useEffect(() => teardown, [teardown]);

  // Fetch which translation engine the server is actually running (cloud
  // API vs. offline Pi-portable fallback vs. local oMLX dev path) so the UI
  // can reflect reality instead of a hardcoded guess -- see
  // EngineStatusChip. Re-fetched whenever serverAddress changes so pointing
  // the client at a different server picks up that server's status.
  useEffect(() => {
    let cancelled = false;
    fetch(`${serverAddress}/api/status`)
      .then((response) => {
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        return response.json();
      })
      .then((data: ServerStatus) => {
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
    transcripts,
    serverAddress,
    setServerAddress,
    localStream,
    serverStatus,
    connect,
    disconnect,
    micOpen,
    setMicOpen,
  };
}
