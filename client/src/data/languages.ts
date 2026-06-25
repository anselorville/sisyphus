/**
 * Language catalogue for the language-pair picker.
 *
 * `code` mirrors the short codes the backend's direction tag uses (see
 * `app/pipeline.py::_LANGUAGE_CODES` / `parse_direction_prefix`, e.g.
 * "ZH->EN"), so a `direction` string from a transcript event can be split
 * on "->" and looked up here directly. `envValue` is the free-text value
 * accepted by the backend's SOURCE_LANG/TARGET_LANG env vars -- this is a
 * best-effort mirror of the *names* that map to those codes; the backend
 * agent owns the authoritative list.
 */

export interface LanguageOption {
  code: string;
  envValue: string;
  label: string;
  nativeLabel: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: "ZH", envValue: "Chinese", label: "Chinese", nativeLabel: "中文" },
  { code: "EN", envValue: "English", label: "English", nativeLabel: "English" },
  { code: "FR", envValue: "French", label: "French", nativeLabel: "Français" },
  { code: "DE", envValue: "German", label: "German", nativeLabel: "Deutsch" },
  { code: "ES", envValue: "Spanish", label: "Spanish", nativeLabel: "Español" },
  { code: "IT", envValue: "Italian", label: "Italian", nativeLabel: "Italiano" },
];

export function findLanguageByCode(code?: string | null): LanguageOption | undefined {
  if (!code) return undefined;
  const normalized = code.trim().toUpperCase();
  return LANGUAGES.find((lang) => lang.code === normalized);
}

/** Split a "XX->YY" direction tag into [from, to] LanguageOptions, falling back to raw codes if unrecognized. */
export function parseDirectionLanguages(
  direction?: string,
): { from: string; to: string } | null {
  if (!direction) return null;
  const [from, to] = direction.split("->").map((part) => part.trim());
  if (!from || !to) return null;
  return { from, to };
}
