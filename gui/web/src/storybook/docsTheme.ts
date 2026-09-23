import { useSyncExternalStore } from "react";
import { create, type ThemeVars } from "storybook/theming";
import {
  PREFERS_LIGHT_QUERY,
  type ResolvedTheme,
  resolvedDocumentTheme,
} from "../hooks/useTheme";

/** Colour format `studioDocsTheme` accepts (Storybook's polished helpers need real colours). */
export const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

/** Re-render when the toolbar flips `data-theme` or the OS scheme changes. */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const media =
    typeof globalThis.matchMedia === "function"
      ? globalThis.matchMedia(PREFERS_LIGHT_QUERY)
      : null;
  media?.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", onChange);
  };
}

/** Effective Studio theme on <html>, kept live for the docs container. */
export function useDocumentTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, resolvedDocumentTheme);
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
