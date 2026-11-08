import { useEffect, useState } from "react";
import type { EngineMode } from "../design-system/components/EngineStatusChip";

/**
 * Maps the server's resolved engine name (`media.engine` in
 * GET /api/agent-runtime/status, from app/providers/transcription.py's
 * `select_engine()`: "cloud" | "offline" | "omlx") onto the chip's display
 * modes. Anything else -- including a failed fetch -- is "unknown".
 */
export function toEngineMode(raw: unknown): EngineMode {
  if (raw === "cloud" || raw === "offline") return raw;
  if (raw === "omlx") return "local-dev";
  return "unknown";
}

/** Fetches the running engine while `enabled` (e.g. while Settings is open), refetching on server address change. */
export function useEngineMode(serverAddress: string, enabled: boolean): EngineMode {
  const [mode, setMode] = useState<EngineMode>("unknown");

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`${serverAddress}/api/agent-runtime/status`)
      .then((response) => {
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        return response.json();
      })
      .then((data: { media?: { engine?: unknown } }) => {
        if (!cancelled) setMode(toEngineMode(data?.media?.engine));
      })
      .catch(() => {
        if (!cancelled) setMode("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [serverAddress, enabled]);

  return mode;
}
