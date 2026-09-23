import {
  applyTheme,
  isThemePreference,
  type ThemePreference,
} from "../hooks/useTheme";

/** Apply globals before a docs page mounts (including standalone MDX). */
export function updateDocsThemeGlobal(globals: Record<string, unknown>): void {
  // GLOBALS_UPDATED precedes docs rendering, so apply tokens before the first
  // studioDocsTheme() calculation. This also works when no story decorator runs.
  applyTheme(themePreferenceFromGlobals(globals));
}

export function themePreferenceFromGlobals(
  globals: Record<string, unknown>,
): ThemePreference {
  return isThemePreference(globals.theme) ? globals.theme : "system";
}
