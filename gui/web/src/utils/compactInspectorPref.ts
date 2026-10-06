/**
 * How the compact phone inspector opens on a timeline selection (#1051 round
 * 3, lab `touchChooser`): as the peek strip, or as the inspector the user last
 * expanded it to. Persisted like `sharecut.laneHeight`, a convenience for this
 * browser, not project state (see `docs/persistence.md`).
 */
import { readLocal, writeLocal } from "./storage";

export type CompactInspectorView = "strip" | "inspector";

export const COMPACT_INSPECTOR_STORAGE_KEY = "sharecut.compactInspector";

export function readCompactInspectorView(): CompactInspectorView {
  return readLocal(COMPACT_INSPECTOR_STORAGE_KEY) === "inspector"
    ? "inspector"
    : "strip";
}

export function writeCompactInspectorView(view: CompactInspectorView): void {
  writeLocal(COMPACT_INSPECTOR_STORAGE_KEY, view);
}
