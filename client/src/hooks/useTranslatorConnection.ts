import { useCallback, useEffect, useRef, useState } from "react";
import { getServerAddress, setServerAddress as persistServerAddress } from "../settings/serverAddress";
import type { ConnectionState, ServerStatus, TranscriptEvent } from "./useTranslatorConnection.types";

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const PING_INTERVAL_MS = 3000;

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
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
  connect: () => Promise<void>;
  disconnect: () => void;
}

export function useTranslatorConnection(): UseTranslatorConnectionResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [transcripts, setTranscripts] = useState<TranscriptEvent[]>([]);
  const [serverAddress, setServerAddressState] = useState<string>(() => getServerAddress());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);

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
        body: JSON.stringify({ sdp: pc.localDescription!.sdp, type: pc.localDescription!.type }),
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
  };
}
