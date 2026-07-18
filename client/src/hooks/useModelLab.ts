import { useCallback, useEffect, useState } from "react";
import type {
  ChainPreviewResult,
  ModelLabFieldValue,
  ModelLabPreset,
  ModelLabSchema,
  ModelLabValues,
  ModelLabValuesUpdate,
  ModelLabVoice,
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
  const [presets, setPresets] = useState<Record<string, ModelLabPreset[]>>({});
  const [voices, setVoices] = useState<ModelLabVoice[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const refresh = useCallback(async () => {
    try {
      const [schemaResponse, valuesResponse, textPresetsResponse, speechPresetsResponse, voicesResponse] = await Promise.all([
        fetch(`${serverAddress}/api/model-lab/schema`),
        fetch(`${serverAddress}/api/model-lab/values`),
        fetch(`${serverAddress}/api/model-lab/presets?capability=text`),
        fetch(`${serverAddress}/api/model-lab/presets?capability=speech`),
        fetch(`${serverAddress}/api/model-lab/voices`),
      ]);
      if (!schemaResponse.ok) throw new Error(`server responded ${schemaResponse.status}`);
      if (!valuesResponse.ok) throw new Error(`server responded ${valuesResponse.status}`);
      const schemaPayload: ModelLabSchema = await schemaResponse.json();
      const valuesPayload: ModelLabValues = await valuesResponse.json();
      setSchema(schemaPayload);
      setValues(valuesPayload);
      setLoadError(false);

      // Load presets for text and speech; tolerate failures gracefully
      const presetsMap: Record<string, ModelLabPreset[]> = {};
      if (textPresetsResponse.ok) {
        const textData: { presets: ModelLabPreset[] } = await textPresetsResponse.json();
        presetsMap.text = textData.presets;
      } else {
        presetsMap.text = [];
      }
      if (speechPresetsResponse.ok) {
        const speechData: { presets: ModelLabPreset[] } = await speechPresetsResponse.json();
        presetsMap.speech = speechData.presets;
      } else {
        presetsMap.speech = [];
      }
      setPresets(presetsMap);

      // Load voices; tolerate failures gracefully
      if (voicesResponse.ok) {
        const voicesData: { voices: ModelLabVoice[] } = await voicesResponse.json();
        setVoices(voicesData.voices);
      } else {
        setVoices([]);
      }
    } catch {
      setSchema(null);
      setValues(null);
      setLoadError(true);
      setPresets({});
      setVoices([]);
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
      const payload: { output_text: string; timing?: { total_ms: number } } = await response.json();
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
      const totalMs = response.headers.get("X-Preview-Total-Ms")
        ? Number(response.headers.get("X-Preview-Total-Ms"))
        : null;
      const audioMs = response.headers.get("X-Preview-Audio-Ms")
        ? Number(response.headers.get("X-Preview-Audio-Ms"))
        : null;
      return { blob, totalMs, audioMs };
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
      const payload: { transcript: string; timing?: { total_ms: number } } = await response.json();
      return payload;
    },
    [serverAddress]
  );

  const previewChain = useCallback(
    async (
      audioFile: File,
      adapterIds: { stt: string; llm: string; tts: string },
      values: Record<string, Record<string, ModelLabFieldValue>>
    ): Promise<ChainPreviewResult> => {
      const form = new FormData();
      form.append("stt_adapter_id", adapterIds.stt);
      form.append("llm_adapter_id", adapterIds.llm);
      form.append("tts_adapter_id", adapterIds.tts);
      form.append("values", JSON.stringify(values));
      form.append("audio", audioFile);

      const response = await fetch(`${serverAddress}/api/model-lab/preview/chain`, {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const errorData: { detail?: string } = await response.json().catch(() => ({}));
        throw new Error(errorData.detail ?? "Chain preview failed");
      }

      const payload: {
        transcript: string;
        translated_text: string;
        direction: string | null;
        tone: string | null;
        timing: { stt_ms: number; llm_ms: number; tts_ms: number; total_ms: number };
        audio_token: string;
      } = await response.json();

      // Fetch audio immediately using the token
      let audioBlob: Blob | null = null;
      try {
        const audioResponse = await fetch(`${serverAddress}/api/model-lab/preview/chain/audio/${payload.audio_token}`);
        if (audioResponse.ok) {
          audioBlob = await audioResponse.blob();
        }
      } catch {
        // Tolerate audio fetch failure; audioBlob stays null
      }

      return {
        transcript: payload.transcript,
        translatedText: payload.translated_text,
        direction: payload.direction,
        tone: payload.tone,
        timing: {
          sttMs: payload.timing.stt_ms,
          llmMs: payload.timing.llm_ms,
          ttsMs: payload.timing.tts_ms,
          totalMs: payload.timing.total_ms,
        },
        audioBlob,
      };
    },
    [serverAddress]
  );

  const createPreset = useCallback(
    async (capability: string, name: string, values: Record<string, ModelLabFieldValue>) => {
      try {
        const response = await fetch(`${serverAddress}/api/model-lab/presets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capability, name, values }),
        });
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        const preset: ModelLabPreset = await response.json();
        // Update local presets state
        setPresets((prev) => ({
          ...prev,
          [capability]: [...(prev[capability] ?? []), preset],
        }));
        return preset;
      } catch {
        return null;
      }
    },
    [serverAddress]
  );

  const deletePreset = useCallback(
    async (capability: string, presetId: string) => {
      try {
        const response = await fetch(`${serverAddress}/api/model-lab/presets/${presetId}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        // Update local presets state
        setPresets((prev) => ({
          ...prev,
          [capability]: (prev[capability] ?? []).filter((p) => p.id !== presetId),
        }));
        return true;
      } catch {
        return false;
      }
    },
    [serverAddress]
  );

  const createVoice = useCallback(
    async (name: string, refText: string, audioFile: File, language?: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const form = new FormData();
        form.append("name", name);
        form.append("ref_text", refText);
        form.append("audio", audioFile);
        if (language) {
          form.append("language", language);
        }
        const response = await fetch(`${serverAddress}/api/model-lab/voices`, {
          method: "POST",
          body: form,
        });
        if (!response.ok) {
          const errorData: { detail?: string } = await response.json().catch(() => ({}));
          return { ok: false, error: errorData.detail ?? "Failed to create voice" };
        }
        // Refresh voices after creating
        await refresh();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
      }
    },
    [serverAddress, refresh]
  );

  const deleteVoice = useCallback(
    async (voiceId: string): Promise<boolean> => {
      try {
        const response = await fetch(`${serverAddress}/api/model-lab/voices/${voiceId}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error(`server responded ${response.status}`);
        // Refresh voices after deleting
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [serverAddress, refresh]
  );

  return {
    schema,
    values,
    presets,
    voices,
    loadError,
    saveState,
    setSaveState,
    refresh,
    saveValues,
    previewText,
    previewSpeech,
    previewTranscription,
    previewChain,
    createPreset,
    deletePreset,
    createVoice,
    deleteVoice,
  };
}
