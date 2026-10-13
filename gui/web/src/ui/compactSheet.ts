/**
 * The inspector sheets as other surfaces see them: the classes that mark their
 * panels, and where they rest, so a timeline target or a floating card can stay
 * clear of them. Every inspector sheet carries `INSPECTOR_SHEET_CLASS`; the
 * compact one (#1051 round 3) also carries `COMPACT_SHEET_CLASS`.
 */
export const INSPECTOR_SHEET_CLASS = "bottom-sheet--inspector";
export const COMPACT_SHEET_CLASS = "bottom-sheet--compact";

export function compactSheetPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${COMPACT_SHEET_CLASS}`);
}

/** The open inspector sheet, compact or regular, or null when none is open. */
export function inspectorSheetPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${INSPECTOR_SHEET_CLASS}`);
}

function restingTop(panel: HTMLElement | null): number | null {
  const root = panel?.closest(".bottom-sheet-root");
  if (!panel || !root) return null;
  // The panel's resting top: its entrance animation moves the drawn box.
  return root.getBoundingClientRect().bottom - panel.offsetHeight;
}

/** The open compact sheet's resting top in viewport px, or null when none is open. */
export function compactSheetTop(): number | null {
  return restingTop(compactSheetPanel());
}

/** The open inspector sheet's resting top in viewport px, or null when none is open. */
export function inspectorSheetTop(): number | null {
  return restingTop(inspectorSheetPanel());
}
