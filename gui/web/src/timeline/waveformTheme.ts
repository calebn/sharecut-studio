import { useSyncExternalStore } from "react";
import {
  PREFERS_LIGHT_QUERY,
  type ResolvedTheme,
  resolvedDocumentTheme,
} from "../hooks/useTheme";
import type { WaveformStyle } from "../waveform/types";

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

const WAVEFORM_CORE_LIGHTEN = 0.45;
const WAVEFORM_EDGE_LIGHTEN = 0.72;

const NUM = String.raw`(-?[\d.]+(?:e[-+]?\d+)?)`;
const ALPHA = String.raw`(?:\s*[,/]\s*([\d.]+%?))?`;
const RGB_RE = new RegExp(
  String.raw`^rgba?\(\s*${NUM}[\s,]+${NUM}[\s,]+${NUM}${ALPHA}\s*\)$`,
  "i",
);
/** What `getComputedStyle` returns for `color-mix()` / `oklch()` fills. */
const SRGB_RE = new RegExp(
  String.raw`^color\(\s*srgb\s+${NUM}\s+${NUM}\s+${NUM}${ALPHA}\s*\)$`,
  "i",
);

function parseAlpha(raw: string | undefined): number {
  if (raw == null) {
    return 1;
  }
  const n = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/**
 * Channels (0–255) and alpha (0–1) of a computed colour: `rgb()` / `rgba()`,
 * or `color(srgb r g b / a)` with 0–1 channels.
 */
export function parseRgb(
  color: string,
): { rgb: [number, number, number]; alpha: number } | null {
  const text = color.trim();
  const rgb = text.match(RGB_RE);
  const srgb = rgb ? null : text.match(SRGB_RE);
  const match = rgb ?? srgb;
  if (!match) {
    return null;
  }
  const scale = srgb ? 255 : 1;
  const channel = (raw: string | undefined) =>
    Math.min(255, Math.max(0, Number(raw) * scale));
  return {
    rgb: [channel(match[1]), channel(match[2]), channel(match[3])],
    alpha: parseAlpha(match[4]),
  };
}

function towardWhite(
  [r, g, b]: [number, number, number],
  amount: number,
): string {
  const mix = (channel: number) =>
    Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/**
 * Waveform tints derived from the clip's own fill, so every track keeps its
 * identity color. Returns null when the fill is unparseable or fully
 * transparent, so the themed peak color applies; partial alpha keeps the
 * channels (clip fills are opaque today).
 */
export function clipWaveformFill(
  clipBackground: string,
): { core: string; edge: string } | null {
  const parsed = parseRgb(clipBackground);
  if (!parsed || parsed.alpha === 0) {
    return null;
  }
  return {
    core: towardWhite(parsed.rgb, WAVEFORM_CORE_LIGHTEN),
    edge: towardWhite(parsed.rgb, WAVEFORM_EDGE_LIGHTEN),
  };
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
  styleByKey.clear();
  peakColorByTheme.clear();
}

/** Edge alpha of the flat fallback: the peak envelope over a solid body. */
const FALLBACK_EDGE_ALPHA = 0.6;

const styleByKey = new Map<string, WaveformStyle>();

/** Resolved `--color-waveform-peak` per theme, kept once it parses (the probe forces a style recalc). */
const peakColorByTheme = new Map<ResolvedTheme, string>();

function rgba(color: string, alphaScale = 1): Float32Array | null {
  const parsed = parseRgb(color);
  if (!parsed) {
    return null;
  }
  const [r, g, b] = parsed.rgb;
  return new Float32Array([
    r / 255,
    g / 255,
    b / 255,
    parsed.alpha * alphaScale,
  ]);
}

/** Set before the real colour: if it is still there, the context rejected the colour. */
const CANVAS_SENTINEL = "#010203";

/**
 * Any CSS colour (`oklch()`, `lab()`, `color(display-p3 …)`) as sRGB
 * `rgba(…)`, read back from a 1×1 canvas. Null without a 2D context, or when
 * the context rejects the colour (an ignored assignment would otherwise paint
 * the default black, which would then be cached for the theme).
 */
function srgbViaCanvas(color: string): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.fillStyle = CANVAS_SENTINEL;
  ctx.fillStyle = color;
  if (
    ctx.fillStyle === CANVAS_SENTINEL &&
    color.trim().toLowerCase() !== CANVAS_SENTINEL
  ) {
    return null;
  }
  ctx.fillRect(0, 0, 1, 1);
  const px = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${px[0] ?? 0}, ${px[1] ?? 0}, ${px[2] ?? 0}, ${(px[3] ?? 0) / 255})`;
}

/**
 * `--color-waveform-peak` as a computed sRGB colour, cached per theme once it
 * parses. The token is `color-mix(…)` text, which `getPropertyValue` returns
 * unresolved; the `color` of a styled probe element resolves it (to
 * `color(srgb …)` / `rgb(…)`), and anything else goes through a canvas.
 */
function waveformPeakColor(theme: ResolvedTheme): string {
  const cached = peakColorByTheme.get(theme);
  if (cached) {
    return cached;
  }
  const token = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-waveform-peak")
    .trim();
  let color = token;
  if (token && !parseRgb(token)) {
    const probe = document.createElement("span");
    probe.style.display = "none";
    probe.style.setProperty("color", "var(--color-waveform-peak)");
    document.documentElement.appendChild(probe);
    color = getComputedStyle(probe).color;
    probe.remove();
  }
  if (color && !parseRgb(color)) {
    color = srgbViaCanvas(color) ?? color;
  }
  if (parseRgb(color)) {
    peakColorByTheme.set(theme, color);
  }
  return color;
}

/**
 * The two-tone look as straight RGBA floats for the raster worker: the RMS
 * body in the lane's core tint, the peak envelope in its edge tint. Resolved
 * once per (theme, lane colour). Without a readable clip fill it falls back
 * to `--color-waveform-peak` (edge at 0.6 alpha; the peak colour is cached
 * per theme once it parses). The fallback style itself is not cached, so a
 * clip-fill read before styles apply does not stick.
 */
export function waveformStyle(
  layerEl: Element,
  colorVar: string,
  theme: ResolvedTheme,
): WaveformStyle {
  const key = `${theme}|${colorVar}`;
  const cached = styleByKey.get(key);
  if (cached) {
    return cached;
  }
  const clip = layerEl.closest(".clip-block");
  const tint = clip && clipWaveformFill(getComputedStyle(clip).backgroundColor);
  const core = tint && rgba(tint.core);
  const edge = tint && rgba(tint.edge);
  if (core && edge) {
    const style = { core, edge };
    styleByKey.set(key, style);
    return style;
  }
  const peak = waveformPeakColor(theme);
  return {
    core: rgba(peak) ?? new Float32Array(4),
    edge: rgba(peak, FALLBACK_EDGE_ALPHA) ?? new Float32Array(4),
  };
}
