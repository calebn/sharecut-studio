import { useSyncExternalStore } from "react";
import { isThemePreference, type ThemePreference } from "../hooks/useTheme";

let preference: ThemePreference = "system";
const listeners = new Set<() => void>();

/** Cache toolbar globals before a docs page mounts (including standalone MDX). */
export function updateDocsThemeGlobal(globals: Record<string, unknown>): void {
  const next = isThemePreference(globals.theme) ? globals.theme : "system";
  if (next === preference) return;
  preference = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ThemePreference {
  return preference;
}

export function useDocsThemeGlobal(): ThemePreference {
  return useSyncExternalStore(subscribe, snapshot);
}
