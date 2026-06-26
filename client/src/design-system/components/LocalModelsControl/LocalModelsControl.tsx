import { Button } from "../../primitives/Button";
import { Badge } from "../../primitives/Badge";
import { useLocalEngine } from "../../../hooks/useLocalEngine";
import type { LocalEngineModel } from "../../../hooks/useTranslatorConnection.types";
import styles from "./LocalModelsControl.module.css";

export interface LocalModelsControlProps {
  serverAddress: string;
}

const ROLE_LABEL: Record<LocalEngineModel["role"], string> = {
  llm: "LLM",
  stt: "ASR",
  tts: "TTS",
};

function modelBadgeText(model: LocalEngineModel): string {
  const label = ROLE_LABEL[model.role];
  if (model.loaded === null) return `${label}: unknown`;
  return model.loaded ? `${label}: loaded` : `${label}: not loaded`;
}

/**
 * Lets a developer explicitly load/unload the 3 oMLX local-dev models
 * (LLM/STT/TTS) instead of having them sit resident in memory for the
 * lifetime of the oMLX server -- see app/server.py's /api/local-engine/*
 * endpoints. Renders nothing if oMLX isn't configured/reachable (calm
 * absence rather than a broken/confusing control), matching how
 * EngineStatusChip's "unknown" state stays unobtrusive.
 */
export function LocalModelsControl({ serverAddress }: LocalModelsControlProps) {
  const { status, busy, error, start, stop } = useLocalEngine(serverAddress);

  // Still loading the first status fetch, or oMLX isn't configured/reachable
  // at all -- hide the section entirely rather than show a broken control.
  if (!status || !status.available) return null;

  const allLoaded = status.models.every((model) => model.loaded === true);
  const isBusy = busy !== null;

  return (
    <div className={styles.control}>
      <div className={styles.modelList}>
        {status.models.map((model) => (
          <Badge key={model.id} tone={model.loaded ? "primary" : "neutral"}>
            {modelBadgeText(model)}
          </Badge>
        ))}
      </div>

      <div className={styles.actions}>
        {allLoaded ? (
          <Button variant="secondary" loading={busy === "stop"} disabled={isBusy} onClick={stop}>
            Stop local models
          </Button>
        ) : (
          <Button variant="secondary" loading={busy === "start"} disabled={isBusy} onClick={start}>
            Start local models
          </Button>
        )}
      </div>

      {error && <p className={styles.errorText}>Couldn't reach the local model controls -- try again.</p>}
    </div>
  );
}
