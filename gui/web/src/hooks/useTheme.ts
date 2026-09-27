/**
 * Theme preference: system | light | dark.
 * Persists override in localStorage; system follows prefers-color-scheme.
 */

import { useCallback, useEffect, useState } from "react";
import { readLocal, writeLocal } from "../utils/storage";

export type ThemePreference = "system" | "light" | "dark";

/** Order and labels for every preference (View › Theme, Storybook toolbar). */
export const THEME_OPTIONS: readonly { id: ThemePreference; label: string }[] =
  [
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ];

export function isThemePreference(v: unknown): v is ThemePreference {
  return THEME_OPTIONS.some((t) => t.id === v);
}

const STORAGE_KEY = "daw_theme";

function readStored(): ThemePreference {
  const v = readLocal(STORAGE_KEY);
  return isThemePreference(v) ? v : "system";
}

/** Shared with the Storybook toolbar decorator (.storybook/preview.ts). */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = preference;
  }
}

export type ResolvedTheme = "light" | "dark";

/** Media query that flips `:root:not([data-theme])` to light (brand-tokens.css). */
export const PREFERS_LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * Effective theme on <html>: explicit `data-theme` wins; otherwise light only
 * when the OS prefers light (dark is the baseline, as in brand-tokens.css).
 */
export function resolvedDocumentTheme(): ResolvedTheme {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") {
    return attr;
  }
  return typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia(PREFERS_LIGHT_QUERY).matches
    ? "light"
    : "dark";
}

/** Call once at app boot so first paint matches stored preference. */
export function initTheme(): ThemePreference {
  const pref = readStored();
  applyTheme(pref);
  return pref;
}

export function useTheme(): {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStored(),
  );

  useEffect(() => {
    applyTheme(preference);
    writeLocal(STORAGE_KEY, preference);
  }, [preference]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
  }, []);

  return { preference, setPreference };
}
