import { COMMANDS } from "../commands/catalog";
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

/** Layout copy for the View menu and Restore chip. Action labels come from the command catalog (`commands/catalog.ts`), which governance.test.ts keeps in step with the keymap and the capabilities manifest. */
export const LAYOUT_MODES: readonly LayoutModeCopy[] = [
  DEFAULT_LAYOUT,
  {
    id: "timeline",
    command: "layout.timeline",
    menuLabel: COMMANDS["layout.timeline"].label,
    chipLabel: "Timeline maximized",
  },
  {
    id: "text",
    command: "layout.text",
    menuLabel: COMMANDS["layout.text"].label,
    chipLabel: "Transcript maximized",
  },
  {
    id: "review",
    command: "layout.review",
    menuLabel: COMMANDS["layout.review"].label,
    chipLabel: "Review layout",
  },
];

export function layoutModeCopy(mode: LayoutMode): LayoutModeCopy {
  return LAYOUT_MODES.find((m) => m.id === mode) ?? DEFAULT_LAYOUT;
}
