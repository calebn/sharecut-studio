/**
 * The phone Inspector sheet as other surfaces see them: the class that marks
 * its panel, and where it rests, so a timeline target or a floating card can
 * stay clear of it.
 */
export const PHONE_SHEET_CLASS = "sys-inspector--phone";

/** The open phone Inspector sheet, or null when none is open. */
export function inspectorSheetPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${PHONE_SHEET_CLASS}`);
}

function restingTop(panel: HTMLElement | null): number | null {
  if (!panel) return null;
  const root = panel.closest(".bottom-sheet-root");
  if (!root) return panel.getBoundingClientRect().top;
  // The panel's resting top: its entrance animation moves the drawn box.
  return root.getBoundingClientRect().bottom - panel.offsetHeight;
}

/** The open inspector sheet's resting top in viewport px, or null when none is open. */
export function inspectorSheetTop(): number | null {
  return restingTop(inspectorSheetPanel());
}
