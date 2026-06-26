export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Shape of the JSON returned by GET /api/status (see app/server.py). */
export interface ServerStatus {
  engine: "cloud" | "offline" | "omlx";
  source_lang: string;
  target_lang: string;
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

interface TranscriptEventBase {
  id: string;
  timestamp: number;
  text: string;
}

export type TranscriptEvent =
  | ({ kind: "original" } & TranscriptEventBase)
  | ({ kind: "translation"; direction?: string } & TranscriptEventBase);
