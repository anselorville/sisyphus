const STORAGE_KEY = "sisyphus-translator:server-address";

export const DEFAULT_SERVER_ADDRESS = "http://localhost:7860";

export function getServerAddress(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_SERVER_ADDRESS;
  } catch {
    return DEFAULT_SERVER_ADDRESS;
  }
}

export function setServerAddress(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // localStorage unavailable (e.g. private browsing) -- setting is session-only.
  }
}
