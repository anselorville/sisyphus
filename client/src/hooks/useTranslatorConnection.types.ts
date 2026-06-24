export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface TranscriptEventBase {
  id: string;
  timestamp: number;
  text: string;
}

export type TranscriptEvent =
  | ({ kind: "original" } & TranscriptEventBase)
  | ({ kind: "translation"; direction?: string } & TranscriptEventBase);
