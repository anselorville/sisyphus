import { useCallback, useEffect, useState } from "react";
import type { LocalEngineStatus } from "./useTranslatorConnection.types";

/**
 * Controls the 3 oMLX local-dev models (LLM/STT/TTS) via the server's
 * `/api/local-engine/*` endpoints (see app/server.py) -- lets a developer
 * load/unload them on demand instead of having them sit resident in memory
 * for the lifetime of the oMLX server. Separate from `useTranslatorConnection`
 * since it has its own fetch/lifecycle concerns (no WebRTC/data channel
 * involved) and isn't required for the main app to function.
 */
export function useLocalEngine(serverAddress: string) {
  const [status, setStatus] = useState<LocalEngineStatus | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${serverAddress}/api/local-engine/status`);
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      const data: LocalEngineStatus = await response.json();
      setStatus(data);
      setError(false);
    } catch {
      setStatus(null);
      setError(true);
    }
  }, [serverAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const start = useCallback(async () => {
    setBusy("start");
    try {
      const response = await fetch(`${serverAddress}/api/local-engine/start`, { method: "POST" });
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      const data: LocalEngineStatus = await response.json();
      setStatus(data);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }, [serverAddress]);

  const stop = useCallback(async () => {
    setBusy("stop");
    try {
      const response = await fetch(`${serverAddress}/api/local-engine/stop`, { method: "POST" });
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      const data: LocalEngineStatus = await response.json();
      setStatus(data);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }, [serverAddress]);

  return { status, busy, error, start, stop, refresh };
}
