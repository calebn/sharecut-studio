/**
 * Whether the bottom drawer was left collapsed to the tool rail (the timeline
 * layout, reached by **Maximize timeline** or by dragging the splitter past its
 * minimum). Persisted like `sharecut.tabsHeight`, a convenience for this
 * browser, not project state (see `docs/persistence.md`). The last height is
 * kept separately, so reopening returns to it.
 */
import { readLocal, removeLocal, writeLocal } from "./storage";

export const DRAWER_COLLAPSED_STORAGE_KEY = "sharecut.tabsCollapsed";

export function readDrawerCollapsed(): boolean {
  return readLocal(DRAWER_COLLAPSED_STORAGE_KEY) === "1";
}

export function writeDrawerCollapsed(collapsed: boolean): void {
  if (collapsed) writeLocal(DRAWER_COLLAPSED_STORAGE_KEY, "1");
  else removeLocal(DRAWER_COLLAPSED_STORAGE_KEY);
}
