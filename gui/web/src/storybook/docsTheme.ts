import { create, type ThemeVars } from "storybook/theming";
import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../hooks/useMediaQueryStore";
import {
  PREFERS_LIGHT_QUERY,
  type ResolvedTheme,
  resolvedDocumentTheme,
} from "../hooks/useTheme";

/** Colour format `studioDocsTheme` accepts (Storybook's polished helpers need real colours). */
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Re-render when the toolbar flips `data-theme` or the OS scheme changes.
 * Each subscriber owns its observer; Storybook mounts one docs container at a
 * time, so share a module-level observer only if more consumers appear.
 */
const subscribe = mediaQuerySubscription([PREFERS_LIGHT_QUERY], (onChange) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => {
    observer.disconnect();
  };
});

const serverTheme = (): ResolvedTheme => "dark";

/** Effective Studio theme on <html>, kept live for the docs container. */
export function useDocumentTheme(): ResolvedTheme {
  return useMediaQueryStore(subscribe, resolvedDocumentTheme, serverTheme);
}

/** A resolved Studio token as hex, or undefined (Storybook's polished helpers need real colours). */
function tokenHex(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return HEX_COLOR_RE.test(value) ? value : undefined;
}

/**
 * Storybook docs theme matching the Studio theme: base light/dark plus the live
 * canvas/text/border tokens, so docs pages use the same colours as story mode (#209).
 */
export function studioDocsTheme(base: ResolvedTheme): ThemeVars {
  const canvas = tokenHex("--color-bg-canvas");
  const text = tokenHex("--color-text-primary");
  const border = tokenHex("--color-border");
  return create({
    base,
    ...(canvas ? { appContentBg: canvas, appPreviewBg: canvas } : {}),
    ...(text ? { textColor: text } : {}),
    ...(border ? { appBorderColor: border } : {}),
  });
}
