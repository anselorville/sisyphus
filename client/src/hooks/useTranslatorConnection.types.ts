export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Shape of the JSON returned by GET /api/status (see app/server.py). */
export interface ServerStatus {
  engine: "cloud" | "offline" | "omlx";
  source_lang: string;
  target_lang: string;
  /** "manual": mic button owns turn boundaries; "auto": hands-free VAD turns. */
  turn_mode?: "manual" | "auto";
}

/** One oMLX model's load state, as reported by GET /api/local-engine/status. */
export interface LocalEngineModel {
  id: string;
  role: "llm" | "stt" | "tts";
  loaded: boolean | null;
}

/**
 * Shape of the JSON returned by GET/POST /api/local-engine/{status,start,stop}
 * (see app/server.py). `available: false` means oMLX isn't configured or is
 * unreachable -- every model's `loaded` is null in that case.
 */
export interface LocalEngineStatus {
  available: boolean;
  models: LocalEngineModel[];
}

/** One tunable field's render metadata, as reported by GET /api/model-settings
 * (see app/model_settings.py's `FieldSchema`). */
export interface ModelSettingsField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select";
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  placeholder?: string;
}

/** A flat (single-engine) section: e.g. llm, stt. */
export interface ModelSettingsSection {
  label: string;
  help?: string;
  fields?: ModelSettingsField[];
  engines?: Record<string, { label: string; fields: ModelSettingsField[] }>;
}

/** Schema half of GET /api/model-settings's response. */
export type ModelSettingsSchema = Record<"llm" | "tts" | "stt", ModelSettingsSection>;

/** Current override values -- every field nullable (null = "use default"). */
export interface LlmModelSettingsValues {
  system_prompt_override: string | null;
  temperature: number | null;
  top_p: number | null;
}

export interface TtsModelSettingsValues {
  voice: string | null;
  speed: number | null;
  instructions_template: string | null;
  temperature: number | null;
  top_p: number | null;
}

export interface SttModelSettingsValues {
  language_hint: string | null;
}

export interface ModelSettingsValues {
  llm: LlmModelSettingsValues;
  tts: TtsModelSettingsValues;
  stt: SttModelSettingsValues;
}

/** Full shape of GET/PUT /api/model-settings (see app/server.py). */
export interface ModelSettingsPayload {
  schema: ModelSettingsSchema;
  values: ModelSettingsValues;
}

/** Partial update body accepted by PUT /api/model-settings -- any subset of
 * sections/fields; omitted ones are left unchanged server-side. */
export type ModelSettingsPartialUpdate = {
  llm?: Partial<LlmModelSettingsValues>;
  tts?: Partial<TtsModelSettingsValues>;
  stt?: Partial<SttModelSettingsValues>;
};

/** Which top-level model-serving mode is active: fully local (oMLX) or cloud APIs. */
export type ModelProviderMode = "local" | "cloud";

/** The 4 model-capability slots a provider/model pair can be assigned to. */
export type ModelCapability = "text" | "speech" | "transcription" | "omni";

/** Local-mode section of GET/PUT /api/model-providers -- see app/model_providers.py.
 * `available_engines` is just `["omlx"]` today, so the UI shows a static label
 * rather than a working dropdown. */
export interface ModelProviderLocalConfig {
  engine: string;
  available_engines: string[];
}

/** One cloud capability's current provider/model plus what's selectable.
 * `omni` always has `provider`/`model` null, empty `available_providers`/
 * `available_models`, and `status: "coming_soon"`. */
export interface ModelProviderCloudCapability {
  provider: string | null;
  model: string | null;
  available_providers: string[];
  available_models: Record<string, string[]>;
  status?: "coming_soon";
}

export type ModelProviderCloudConfig = Record<ModelCapability, ModelProviderCloudCapability>;

/** Full shape of GET/PUT /api/model-providers (see app/model_providers.py). */
export interface ModelProvidersPayload {
  mode: ModelProviderMode;
  local: ModelProviderLocalConfig;
  cloud: ModelProviderCloudConfig;
}

/** Partial update body accepted by PUT /api/model-providers -- any subset of
 * mode/local/cloud/capabilities; omitted ones are left unchanged server-side. */
export type ModelProvidersPartialUpdate = {
  mode?: ModelProviderMode;
  local?: Partial<ModelProviderLocalConfig>;
  cloud?: Partial<Record<ModelCapability, Partial<Pick<ModelProviderCloudCapability, "provider" | "model">>>>;
};

/** A single tunable field's render metadata, as reported by GET
 * /api/model-lab/schema (see app/model_lab.py's `FieldSchema` -- the new,
 * dynamic-schema replacement for the old fixed-shape /api/model-settings).
 * `kind` mirrors the old `ModelSettingsField.type` but adds "boolean". */
export interface ModelLabField {
  key: string;
  label: string;
  kind: "text" | "textarea" | "number" | "boolean" | "select";
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  default?: unknown;
}

/** One adapter -- a concrete model/engine backing a capability (e.g. "Cloud"
 * or a specific local oMLX model) -- with its own field list. Multiple
 * adapters can coexist per capability; the user switches between them. */
export interface ModelLabAdapter {
  id: string;
  label: string;
  capability: ModelLabCapability;
  fields: ModelLabField[];
}

/** The 3 model-lab capability slots -- distinct from `ModelCapability`
 * (which also includes "omni", not relevant to per-adapter tuning yet). */
export type ModelLabCapability = "text" | "speech" | "transcription";

/** Full shape of GET /api/model-lab/schema. */
export type ModelLabSchema = Record<ModelLabCapability, { adapters: ModelLabAdapter[] }>;

/** A single field value as accepted/returned by the model-lab values store.
 * Sparse -- only fields the user has touched are present. */
export type ModelLabFieldValue = string | number | boolean | null;

/** Shape of GET /api/model-lab/values and the PUT response -- saved values
 * keyed by adapter id, each a sparse map of field key -> value. */
export type ModelLabValues = Record<string, Record<string, ModelLabFieldValue>>;

/** Body accepted by PUT /api/model-lab/values -- partial values for one or
 * more adapters; omitted fields/adapters are left unchanged server-side. */
export type ModelLabValuesUpdate = Record<string, Record<string, ModelLabFieldValue>>;

/** A named preset (bundle of field values) for a specific capability,
 * as returned by GET /api/model-lab/presets. Builtin presets (builtin: true)
 * cannot be modified or deleted. */
export interface ModelLabPreset {
  id: string;
  name: string;
  builtin: boolean;
  values: Record<string, ModelLabFieldValue>;
}

/** A voice in the voice library for TTS voice cloning. */
export interface ModelLabVoice {
  id: string;
  name: string;
  language: string | null;
  created_at: string;
}

interface TranscriptEventBase {
  id: string;
  timestamp: number;
  text: string;
}

export type TranscriptEvent =
  | ({ kind: "original" } & TranscriptEventBase)
  | ({ kind: "translation"; direction?: string } & TranscriptEventBase);

/** Result from a full chain preview (STT → LLM → TTS). */
export interface ChainPreviewResult {
  transcript: string;
  translatedText: string;
  direction: string | null;
  tone: string | null;
  timing: {
    sttMs: number;
    llmMs: number;
    ttsMs: number;
    totalMs: number;
  };
  audioBlob: Blob | null;
}
