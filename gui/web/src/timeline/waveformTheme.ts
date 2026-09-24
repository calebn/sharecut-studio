import { useSyncExternalStore } from "react";
import {
  PREFERS_LIGHT_QUERY,
  type ResolvedTheme,
  resolvedDocumentTheme,
} from "../hooks/useTheme";
import { clipWaveformFill } from "./drawWaveform";

/*
 * Waveform canvases bake theme colours into pixels, so they must repaint when
 * the resolved theme flips: the Theme menu writes `html[data-theme]` from an
 * effect, and "system" follows the OS `prefers-color-scheme`. Every visible
 * clip subscribes, so they share one MutationObserver and one media listener.
 */
const themeListeners = new Set<() => void>();
let stopWatchingTheme: (() => void) | null = null;

function notifyTheme(): void {
  for (const listener of themeListeners) {
    listener();
  }
}

function watchDocumentTheme(): () => void {
  const observer = new MutationObserver(notifyTheme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const media =
    typeof globalThis.matchMedia === "function"
      ? globalThis.matchMedia(PREFERS_LIGHT_QUERY)
      : null;
  media?.addEventListener?.("change", notifyTheme);
  return () => {
    observer.disconnect();
    media?.removeEventListener?.("change", notifyTheme);
  };
}

export function subscribeResolvedTheme(onChange: () => void): () => void {
  themeListeners.add(onChange);
  stopWatchingTheme ??= watchDocumentTheme();
  return () => {
    themeListeners.delete(onChange);
    if (themeListeners.size === 0 && stopWatchingTheme) {
      stopWatchingTheme();
      stopWatchingTheme = null;
    }
  };
}

/** Effective theme on `<html>`, kept live across Theme-menu and OS changes. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(
    subscribeResolvedTheme,
    resolvedDocumentTheme,
    () => "dark",
  );
}

/** Waveform colours for one (clip colour, theme) pair. */
export type WaveformFill = {
  /** Flat themed peak colour (`--color-waveform-peak`), the fallback. */
  peak: string;
  /** Clip-tinted gradient stops, when the clip fill parses. */
  core?: string;
  edge?: string;
};

/*
 * The fill depends only on the lane colour prop (e.g. `var(--clip-music)`) and
 * the resolved theme, a handful of pairs. Resolve each once instead of forcing
 * a style read per clip per frame. Failed reads are not cached, so a paint
 * before styles apply cannot pin the flat fallback for the session.
 */
const peakByTheme = new Map<ResolvedTheme, string>();
const tintByKey = new Map<string, { core: string; edge: string }>();

export function resolveWaveformFill(
  canvas: HTMLCanvasElement,
  color: string,
  theme: ResolvedTheme,
): WaveformFill {
  let peak = peakByTheme.get(theme);
  if (peak === undefined) {
    peak = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-waveform-peak")
      .trim();
    if (peak) {
      peakByTheme.set(theme, peak);
    }
  }
  const key = `${theme}|${color}`;
  let tint = tintByKey.get(key);
  if (!tint) {
    const clip = canvas.closest(".clip-block");
    tint =
      (clip && clipWaveformFill(getComputedStyle(clip).backgroundColor)) ??
      undefined;
    if (tint) {
      tintByKey.set(key, tint);
    }
  }
  return tint ? { peak, ...tint } : { peak };
}

/** Forget resolved fills (tests; tokens edited under a live page). */
export function clearWaveformFillCache(): void {
  peakByTheme.clear();
  tintByKey.clear();
}
