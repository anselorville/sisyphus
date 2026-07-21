import type { ChangeEvent } from "react";
import { Server } from "lucide-react";
import styles from "./ServerAddressInput.module.css";

export interface ServerAddressInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ServerAddressInput({ value, onChange, disabled = false }: ServerAddressInputProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value);

  return (
    <label className={styles.field}>
      <span className={styles.label}>Server address</span>
      <div className={styles.inputWrap} data-disabled={disabled}>
        <Server size={16} className={styles.icon} />
        <input
          className={styles.input}
          type="text"
          inputMode="url"
          spellCheck={false}
          placeholder="http://localhost:7860"
          value={value}
          onChange={handleChange}
          disabled={disabled}
        />
      </div>
      {disabled && <span className={styles.hint}>Disconnect to change the server address.</span>}
    </label>
  );
}
