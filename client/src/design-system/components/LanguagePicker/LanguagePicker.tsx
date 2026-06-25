import { Check } from "lucide-react";
import { LANGUAGES, type LanguageOption } from "../../../data/languages";
import styles from "./LanguagePicker.module.css";

export interface LanguagePickerProps {
  label: string;
  value: LanguageOption;
  onChange: (language: LanguageOption) => void;
  /** Languages to exclude from selection, e.g. the language already picked on the other side. */
  disabledCodes?: string[];
}

/**
 * A real language picker: a grid of selectable language tiles (code +
 * native name), not a raw text input. Covers the European languages the
 * backend currently supports (English, French, German, Spanish, Italian)
 * plus Chinese -- see app/pipeline.py::_LANGUAGE_CODES.
 */
export function LanguagePicker({ label, value, onChange, disabledCodes = [] }: LanguagePickerProps) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.grid} role="radiogroup" aria-label={label}>
        {LANGUAGES.map((language) => {
          const isSelected = language.code === value.code;
          const isDisabled = disabledCodes.includes(language.code) && !isSelected;
          return (
            <button
              key={language.code}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={styles.tile}
              data-selected={isSelected || undefined}
              disabled={isDisabled}
              onClick={() => onChange(language)}
            >
              <span className={styles.code}>{language.code}</span>
              <span className={styles.name}>{language.nativeLabel}</span>
              {isSelected && <Check size={14} className={styles.check} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
