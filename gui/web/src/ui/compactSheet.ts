/**
 * The compact inspector sheet (#1051 round 3) as other surfaces see it: the
 * class that marks its panel, and where it rests, so a timeline target or a
 * floating card can stay clear of it.
 */
export const COMPACT_SHEET_CLASS = "bottom-sheet--compact";

export function compactSheetPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${COMPACT_SHEET_CLASS}`);
}

/** The open compact sheet's resting top in viewport px, or null when none is open. */
export function compactSheetTop(): number | null {
  const panel = compactSheetPanel();
  const root = panel?.closest(".bottom-sheet-root");
  if (!panel || !root) return null;
  // The panel's resting top: its entrance animation moves the drawn box.
  return root.getBoundingClientRect().bottom - panel.offsetHeight;
}
