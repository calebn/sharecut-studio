/**
 * Guarded `localStorage` access for per-browser conveniences.
 *
 * Reading or writing can throw (Safari private mode / blocked site data raise
 * `SecurityError`, full storage raises a quota error) and the global may be
 * missing entirely. Callers often run inside `useState` initializers, so these
 * helpers never throw: reads fall back to `null`, writes are dropped.
 */

export function readLocal(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* SecurityError / quota: preference just is not persisted */
  }
}

/** Per-tab, per-launch twin of `readLocal`: gone when the tab or app window closes. */
export function readSession(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeSession(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    /* SecurityError / quota: the choice just lasts until the next render */
  }
}

export function removeLocal(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* SecurityError: nothing to clear */
  }
}
