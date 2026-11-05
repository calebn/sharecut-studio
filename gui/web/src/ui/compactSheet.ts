/**
 * The phone Inspector sheet as other surfaces see them: the class that marks
 * its panel, and where it rests, so a timeline target or a floating card can
 * stay clear of it.
 */
import type { Selection } from "../types/project";

export const PHONE_SHEET_CLASS = "sys-inspector--phone";

/** The track whose lane `selection`'s sheet must leave in view, or null. */
export function editedLaneTrack(selection: Selection): string | null {
  return selection?.kind === "envelope" || selection?.kind === "envelopePoint"
    ? selection.trackId
    : null;
}

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

/** Where the open inspector sheet's slot ends in viewport px, or null when none is open. */
export function inspectorSheetBottom(): number | null {
  const panel = inspectorSheetPanel();
  if (!panel) return null;
  return (panel.closest(".bottom-sheet-root") ?? panel).getBoundingClientRect()
    .bottom;
}

/**
 * Shortens the open inspector sheet to `height` px (null lifts the cap) so it
 * leaves the band a lane-editing selection needs in view above it.
 */
export function capInspectorSheetForLane(height: number | null): void {
  const panel = inspectorSheetPanel();
  if (!panel) return;
  if (height === null) panel.style.removeProperty("--sheet-lane-cap");
  else panel.style.setProperty("--sheet-lane-cap", `${Math.round(height)}px`);
}
