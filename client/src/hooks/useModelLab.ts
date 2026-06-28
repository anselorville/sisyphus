import { useCallback, useEffect, useState } from "react";
import type {
  ModelLabFieldValue,
  ModelLabSchema,
  ModelLabValues,
  ModelLabValuesUpdate,
} from "./useTranslatorConnection.types";

export type SaveState = "idle" | "saving" | "saved" | "error";
export type PreviewState = "idle" | "running" | "error";

/**
 * Loads and saves the "Model Lab" tuning settings via the server's
 * `/api/model-lab` endpoints (see app/model_lab.py), and drives the "test it
 * now" preview calls. Replaces `useModelSettings`'s role: the schema is now
 * dynamic (a list of adapters per capability, each with its own field list)
 * rather than a fixed per-role shape, and preview calls let the UI play back
 * real model output for the *draft* (not-yet-saved) values.
 *
 * Same fetch/lifecycle posture as `useModelSettings`/`useModelProviders`:
 * own effect for the initial load, graceful "couldn't reach the server"
 * states rather than throwing/crashing.
 */
export function useModelLab(serverAddress: string) {
  const [schema, setSchema] = useState<ModelLabSchema | null>(null);
  const [values, setValues] = useState<ModelLabValues | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const refresh = useCallback(async () => {
    try {
      const [schemaResponse, valuesResponse] = await Promise.all([
        fetch(`${serverAddress}/api/model-lab/schema`),
        fetch(`${serverAddress}/api/model-lab/values`),
      ]);
      if (!schemaResponse.ok) throw new Error(`server responded ${schemaResponse.status}`);
      if (!valuesResponse.ok) throw new Error(`server responded ${valuesResponse.status}`);
      const schemaPayload: ModelLabSchema = await schemaResponse.json();
      const valuesPayload: ModelLabValues = await valuesResponse.json();
      setSchema(schemaPayload);
      setValues(valuesPayload);
      setLoadError(false);
    } catch {
      setSchema(null);
      setValues(null);
      setLoadError(true);
    }
  }, [serverAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveValues = useCallback(
    async (adapterId: string, partial: Record<string, ModelLabFieldValue>) => {
      setSaveState("saving");
      try {
        const body: ModelLabValuesUpdate = { [adapterId]: partial };
        const response = await fetch(`${serverAddress}/api/model-lab/values`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        const payload: ModelLabValues = await response.json();
        setValues(payload);
        setSaveState("saved");
        return true;
      } catch {
        setSaveState("error");
        return false;
      }
    },
    [serverAddress]
  );

  const previewText = useCallback(
    async (adapterId: string, draftValues: Record<string, ModelLabFieldValue>, inputText: string) => {
      const response = await fetch(`${serverAddress}/api/model-lab/preview/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapter_id: adapterId, values: draftValues, input_text: inputText }),
      });
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      const payload: { output_text: string } = await response.json();
      return payload;
    },
    [serverAddress]
  );

  const previewSpeech = useCallback(
    async (adapterId: string, draftValues: Record<string, ModelLabFieldValue>, inputText: string) => {
      const response = await fetch(`${serverAddress}/api/model-lab/preview/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapter_id: adapterId, values: draftValues, input_text: inputText }),
      });
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      const blob = await response.blob();
      return blob;
    },
    [serverAddress]
  );

  const previewTranscription = useCallback(
    async (adapterId: string, draftValues: Record<string, ModelLabFieldValue>, audioFile: File) => {
      const form = new FormData();
      form.append("adapter_id", adapterId);
      form.append("values", JSON.stringify(draftValues));
      form.append("audio", audioFile);
      const response = await fetch(`${serverAddress}/api/model-lab/preview/transcription`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw new Error(`server responded ${response.status}`);
      const payload: { transcript: string } = await response.json();
      return payload;
    },
    [serverAddress]
  );

  return {
    schema,
    values,
    loadError,
    saveState,
    setSaveState,
    refresh,
    saveValues,
    previewText,
    previewSpeech,
    previewTranscription,
  };
}
