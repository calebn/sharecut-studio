/**
 * Theme preference: system | light | dark.
 * Persists override in localStorage; system follows prefers-color-scheme.
 */

import { useCallback, useEffect, useState } from "react";
import { readLocal, writeLocal } from "../utils/storage";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "daw_theme";

function readStored(): ThemePreference {
  const v = readLocal(STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") {
    return v;
  }
  return "system";
}

function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = preference;
  }
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
