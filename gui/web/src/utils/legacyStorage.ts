/** Copy `legacy` → `current` once if `current` is unset. Returns the value under `current`. */
export function migrateLocalStorageKey(
  current: string,
  legacy: string,
): string | null {
  try {
    const existing = localStorage.getItem(current);
    if (existing !== null) {
      return existing;
    }
    const old = localStorage.getItem(legacy);
    if (old === null) {
      return null;
    }
    localStorage.setItem(current, old);
    localStorage.removeItem(legacy);
    return old;
  } catch {
    return null;
  }
}
