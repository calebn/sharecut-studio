/**
 * Theme preference: system | light | dark.
 * Persists override in localStorage; system follows prefers-color-scheme.
 */

import { useCallback, useEffect, useState } from "react";
import { readLocal, writeLocal } from "../utils/storage";

export type ThemePreference = "system" | "light" | "dark";

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
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
  cyclePreference: () => void;
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

  const cyclePreference = useCallback(() => {
    setPreferenceState((prev) => {
      if (prev === "system") {
        return "dark";
      }
      if (prev === "dark") {
        return "light";
      }
      return "system";
    });
  }, []);

  return { preference, setPreference, cyclePreference };
}
