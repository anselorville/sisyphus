import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Badge } from "../../primitives/Badge";
import { Button } from "../../primitives/Button";
import type { ModelLabPreset } from "../../../hooks/useTranslatorConnection.types";
import styles from "./ModelLabScreen.module.css";

export interface PresetBarProps {
  presets: ModelLabPreset[];
  selectedId: string | null;
  modified: boolean;
  onApply: (preset: ModelLabPreset) => void;
  onSaveAs: (name: string) => Promise<boolean>;
  onDelete: (preset: ModelLabPreset) => void;
}

export function PresetBar({ presets, selectedId, modified, onApply, onSaveAs, onDelete }: PresetBarProps) {
  const [showSaveAsInput, setShowSaveAsInput] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [savingAs, setSavingAs] = useState(false);

  const selectedPreset = presets.find((p) => p.id === selectedId);

  async function handleSaveAs() {
    if (!saveAsName.trim()) return;
    setSavingAs(true);
    try {
      const ok = await onSaveAs(saveAsName);
      if (ok) {
        setSaveAsName("");
        setShowSaveAsInput(false);
      }
    } finally {
      setSavingAs(false);
    }
  }

  function handleDeleteClick() {
    if (selectedPreset) {
      onDelete(selectedPreset);
    }
  }

  return (
    <div className={styles.presetBar}>
      <div className={styles.presetRow}>
        <label className={styles.fieldLabel} htmlFor="preset-select">
          Preset
        </label>
        <select
          id="preset-select"
          className={styles.select}
          value={selectedId ?? ""}
          onChange={(event) => {
            const presetId = event.target.value;
            if (presetId) {
              const preset = presets.find((p) => p.id === presetId);
              if (preset) onApply(preset);
            }
          }}
        >
          <option value="">—</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>

        {modified && <Badge tone="neutral">Modified</Badge>}

        <Button variant="secondary" onClick={() => setShowSaveAsInput(!showSaveAsInput)}>
          Save as…
        </Button>

        {selectedPreset && !selectedPreset.builtin && (
          <Button variant="secondary" onClick={handleDeleteClick}>
            <Trash2 size={14} />
          </Button>
        )}
      </div>

      {showSaveAsInput && (
        <div className={styles.presetSaveAsRow}>
          <input
            type="text"
            className={styles.textInput}
            placeholder="Preset name…"
            value={saveAsName}
            onChange={(event) => setSaveAsName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSaveAs();
              if (event.key === "Escape") {
                setShowSaveAsInput(false);
                setSaveAsName("");
              }
            }}
            autoFocus
          />
          <Button variant="secondary" loading={savingAs} disabled={!saveAsName.trim()} onClick={handleSaveAs}>
            Confirm
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setShowSaveAsInput(false);
              setSaveAsName("");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
