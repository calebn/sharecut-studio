/**
 * Theme preference: system | light | dark.
 * Persists override in localStorage; system follows prefers-color-scheme.
 */

import { useSyncExternalStore } from "react";
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

export const THEME_STORAGE_KEY = "daw_theme";

function readStored(): ThemePreference {
  const v = readLocal(THEME_STORAGE_KEY);
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

/**
 * The one preference every `useTheme` caller shares, so the Project menu and
 * the Settings sheet cannot disagree. Read lazily from storage on first use.
 */
let current: ThemePreference | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): ThemePreference {
  current ??= readStored();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Choose a theme: apply it, remember it, and tell every subscriber. */
export function setThemePreference(p: ThemePreference): void {
  current = p;
  applyTheme(p);
  writeLocal(THEME_STORAGE_KEY, p);
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Test seam: module state outlives renders, so a test starts from storage again. */
export function __resetThemeForTests(): void {
  current = null;
  listeners.clear();
}

/** Call once at app boot so first paint matches stored preference. */
export function initTheme(): ThemePreference {
  const pref = readStored();
  current = pref;
  applyTheme(pref);
  for (const listener of [...listeners]) {
    listener();
  }
  return pref;
}

export function useTheme(): {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
} {
  const preference = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  return { preference, setPreference: setThemePreference };
}
