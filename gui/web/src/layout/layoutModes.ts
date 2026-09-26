import type { LayoutMode } from "../state/types";

export type LayoutModeCopy = {
  id: LayoutMode;
  command: string;
  menuLabel: string;
  /** Restore-chip text; null for the default layout (no chip). */
  chipLabel: string | null;
};

const DEFAULT_LAYOUT: LayoutModeCopy = {
  id: "default",
  command: "layout.default",
  menuLabel: "Default layout",
  chipLabel: null,
};

/** Single source of layout copy for the View menu, toggle and Restore chip. */
export const LAYOUT_MODES: readonly LayoutModeCopy[] = [
  DEFAULT_LAYOUT,
  {
    id: "timeline",
    command: "layout.timeline",
    menuLabel: "Maximize timeline",
    chipLabel: "Timeline maximized",
  },
  {
    id: "text",
    command: "layout.text",
    menuLabel: "Maximize transcript",
    chipLabel: "Transcript maximized",
  },
  {
    id: "review",
    command: "layout.review",
    menuLabel: "Review layout",
    chipLabel: "Review layout",
  },
];

export function layoutModeCopy(mode: LayoutMode): LayoutModeCopy {
  return LAYOUT_MODES.find((m) => m.id === mode) ?? DEFAULT_LAYOUT;
}
