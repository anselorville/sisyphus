import { useCallback, useEffect, useState } from "react";
import type { ModelSettingsPartialUpdate, ModelSettingsPayload } from "./useTranslatorConnection.types";

export type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Loads and saves the "Model Lab" tuning settings via the server's
 * `/api/model-settings` endpoints (see app/server.py / app/model_settings.py).
 *
 * Separate from `useTranslatorConnection`/`useLocalEngine` for the same
 * reason those are separate from each other: its own fetch/lifecycle
 * concerns, no WebRTC/data-channel involvement, not required for the main
 * app to function.
 */
export function useModelSettings(serverAddress: string) {
  const [data, setData] = useState<ModelSettingsPayload | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${serverAddress}/api/model-settings`);
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      const payload: ModelSettingsPayload = await response.json();
      setData(payload);
      setLoadError(false);
    } catch {
      setData(null);
      setLoadError(true);
    }
  }, [serverAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(
    async (partial: ModelSettingsPartialUpdate) => {
      setSaveState("saving");
      try {
        const response = await fetch(`${serverAddress}/api/model-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(partial),
        });
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        const payload: ModelSettingsPayload = await response.json();
        setData(payload);
        setSaveState("saved");
        return true;
      } catch {
        setSaveState("error");
        return false;
      }
    },
    [serverAddress]
  );

  return { data, loadError, saveState, setSaveState, refresh, save };
}
