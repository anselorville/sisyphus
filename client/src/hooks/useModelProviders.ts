import { useCallback, useEffect, useState } from "react";
import type { ModelProvidersPartialUpdate, ModelProvidersPayload } from "./useTranslatorConnection.types";

/**
 * Loads and saves the "Model Provider" infrastructure-capability settings via
 * the server's `/api/model-providers` endpoint (see app/model_providers.py).
 *
 * Mirrors `useModelSettings`'s shape exactly: separate fetch/lifecycle
 * concerns from `useTranslatorConnection`, optimistic-update on save (the
 * server's response becomes the new local state), no WebRTC involvement.
 */
export function useModelProviders(serverAddress: string) {
  const [data, setData] = useState<ModelProvidersPayload | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [updateError, setUpdateError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${serverAddress}/api/model-providers`);
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      const payload: ModelProvidersPayload = await response.json();
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

  const update = useCallback(
    async (partial: ModelProvidersPartialUpdate) => {
      try {
        const response = await fetch(`${serverAddress}/api/model-providers`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(partial),
        });
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        const payload: ModelProvidersPayload = await response.json();
        setData(payload);
        setUpdateError(false);
        return true;
      } catch {
        setUpdateError(true);
        return false;
      }
    },
    [serverAddress]
  );

  return { data, loadError, updateError, refresh, update };
}
