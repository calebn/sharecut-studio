/**
 * Per-browser, per-project waveform view (#530): scale mode, amplitude and
 * post-fader drawing, in one `localStorage` map keyed by project path. A
 * convenience like `sharecut.laneHeight`, not durable project state.
 */
import type { WaveformScaleMode } from "../waveform/types";
import { readLocal, writeLocal } from "./storage";
import { clampWaveformAmp } from "./zoom";

export interface WaveformViewPref {
  scale: WaveformScaleMode;
  amp: number;
  postFader: boolean;
}

export const WAVEFORM_VIEW_STORAGE_KEY = "sharecut.waveformView";

/** Most-recent projects kept; older entries are dropped on write. */
export const WAVEFORM_VIEW_MAX_PROJECTS = 32;

export const DEFAULT_WAVEFORM_VIEW_PREF: Readonly<WaveformViewPref> =
  Object.freeze({
    scale: "auto",
    amp: 1,
    postFader: false,
  });

function isWaveformScaleMode(value: unknown): value is WaveformScaleMode {
  return value === "auto" || value === "linear" || value === "log";
}

function parseWaveformViewPref(value: unknown): WaveformViewPref {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_WAVEFORM_VIEW_PREF };
  }
  const { scale, amp, postFader } = value as {
    scale?: unknown;
    amp?: unknown;
    postFader?: unknown;
  };
  return {
    scale: isWaveformScaleMode(scale)
      ? scale
      : DEFAULT_WAVEFORM_VIEW_PREF.scale,
    amp: clampWaveformAmp(typeof amp === "number" ? amp : NaN),
    postFader: postFader === true,
  };
}

/** Parses the stored map; any missing/invalid shape falls back to an empty map. Never throws. */
export function parseWaveformViewPrefs(
  raw: string | null,
): Map<string, WaveformViewPref> {
  if (raw == null) {
    return new Map();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return new Map();
    }
    const map = new Map<string, WaveformViewPref>();
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      map.set(key, parseWaveformViewPref(value));
    }
    return map;
  } catch {
    return new Map();
  }
}

export function readWaveformViewPref(projectPath: string): WaveformViewPref {
  const map = parseWaveformViewPrefs(readLocal(WAVEFORM_VIEW_STORAGE_KEY));
  const entry = map.get(projectPath);
  return entry ? entry : { ...DEFAULT_WAVEFORM_VIEW_PREF };
}

export function writeWaveformViewPref(
  projectPath: string,
  pref: WaveformViewPref,
): void {
  if (projectPath === "") {
    return;
  }
  const map = parseWaveformViewPrefs(readLocal(WAVEFORM_VIEW_STORAGE_KEY));
  map.delete(projectPath);
  map.set(projectPath, { ...pref, amp: clampWaveformAmp(pref.amp) });
  while (map.size > WAVEFORM_VIEW_MAX_PROJECTS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
  writeLocal(
    WAVEFORM_VIEW_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(map)),
  );
}

/** The store patch a project switch hydrates from this project's saved view. */
export function waveformViewState(projectPath: string): {
  waveformScale: WaveformScaleMode;
  waveformAmpZoom: number;
  waveformPostFader: boolean;
} {
  const pref = readWaveformViewPref(projectPath);
  return {
    waveformScale: pref.scale,
    waveformAmpZoom: pref.amp,
    waveformPostFader: pref.postFader,
  };
}
