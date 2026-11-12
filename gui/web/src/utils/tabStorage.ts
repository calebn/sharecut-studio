export function getTab(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setTab(key: string, value: string): boolean {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) {
      return false;
    }
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
