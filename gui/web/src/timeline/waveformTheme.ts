import type { ResolvedTheme } from "../hooks/useTheme";
import { clipWaveformFill } from "./drawWaveform";

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
