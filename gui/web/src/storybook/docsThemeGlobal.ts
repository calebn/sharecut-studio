import {
  applyTheme,
  isThemePreference,
  type ThemePreference,
} from "../hooks/useTheme";

export function docsStoryParentRoot(): HTMLElement | null {
  const frame = window.frameElement;
  return frame?.id.startsWith("iframe--")
    ? frame.ownerDocument.documentElement
    : null;
}

/** Apply globals in the owning preview; nested Docs stories inherit its theme. */
export function updateDocsThemeGlobal(globals: Record<string, unknown>): void {
  if (!docsStoryParentRoot()) applyTheme(themePreferenceFromGlobals(globals));
}

export function themePreferenceFromGlobals(
  globals: Record<string, unknown>,
): ThemePreference {
  return isThemePreference(globals.theme) ? globals.theme : "system";
}
