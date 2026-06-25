export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** Shape of the JSON returned by GET /api/status (see app/server.py). */
export interface ServerStatus {
  engine: "cloud" | "offline" | "omlx";
  source_lang: string;
  target_lang: string;
}

interface TranscriptEventBase {
  id: string;
  timestamp: number;
  text: string;
}

export type TranscriptEvent =
  | ({ kind: "original" } & TranscriptEventBase)
  | ({ kind: "translation"; direction?: string } & TranscriptEventBase);
