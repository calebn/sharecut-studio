import { readLocal, writeLocal } from "./storage";

const SNAP_STORAGE_KEY = "sharecut.snap";

export function readSnapPref(): boolean {
  return readLocal(SNAP_STORAGE_KEY) !== "off";
}

export function writeSnapPref(enabled: boolean): void {
  writeLocal(SNAP_STORAGE_KEY, enabled ? "on" : "off");
}
