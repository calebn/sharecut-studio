/**
 * Per-browser snap preference: whether timeline drags and the suggestion
 * Start/End commit pull to nearby cut points. A convenience like
 * `sharecut.laneHeight`, not durable project state.
 */
import { readLocal, writeLocal } from "./storage";

export const SNAP_STORAGE_KEY = "sharecut.snap";

export function parseSnapPref(raw: string | null): boolean {
  return raw !== "off";
}

export function readSnapPref(): boolean {
  return parseSnapPref(readLocal(SNAP_STORAGE_KEY));
}

export function writeSnapPref(enabled: boolean): void {
  writeLocal(SNAP_STORAGE_KEY, enabled ? "on" : "off");
}
