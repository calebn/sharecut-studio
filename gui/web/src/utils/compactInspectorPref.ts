/**
 * How the compact phone inspector opens on a timeline selection (#1051 rounds
 * 3 and 4b): at the drawer detent the user last left it at, half or full
 * height; any other stored value reads as half. Persisted like
 * `sharecut.laneHeight`, a convenience for this browser, not project state
 * (see `docs/persistence.md`).
 */
import { readLocal, writeLocal } from "./storage";

export const COMPACT_INSPECTOR_VIEWS = ["half", "full"] as const;

export type CompactInspectorView = (typeof COMPACT_INSPECTOR_VIEWS)[number];

export const COMPACT_INSPECTOR_STORAGE_KEY = "sharecut.compactInspector";

export function readCompactInspectorView(): CompactInspectorView {
  const stored = readLocal(COMPACT_INSPECTOR_STORAGE_KEY);
  return COMPACT_INSPECTOR_VIEWS.find((view) => view === stored) ?? "half";
}

export function writeCompactInspectorView(view: CompactInspectorView): void {
  writeLocal(COMPACT_INSPECTOR_STORAGE_KEY, view);
}
