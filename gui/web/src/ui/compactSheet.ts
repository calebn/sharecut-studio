/**
 * The inspector sheets as other surfaces see them: the classes that mark their
 * panels, and where they rest, so a timeline target or a floating card can stay
 * clear of them. Every inspector sheet carries `INSPECTOR_SHEET_CLASS`; the
 * compact one (#1051 round 3) also carries `COMPACT_SHEET_CLASS`.
 */
import type { Selection } from "../types/project";
import { tokenHeightPx } from "./tokenHeight";

export const INSPECTOR_SHEET_CLASS = "bottom-sheet--inspector";
export const PHONE_SHEET_CLASS = "sys-inspector--phone";
export const COMPACT_SHEET_CLASS = "bottom-sheet--compact";
export const CHROME_SCROLLS_CLASS = "bottom-sheet--chrome-scrolls";

/**
 * Marks a regular inspector sheet whose target is a lane (a volume envelope):
 * on a short screen the tabs row gives way and the sheet leaves that lane in
 * view above it (`useKeepEditedLaneClear`, `responsive.css`).
 */
export const LANE_BAND_SHEET_CLASS = "bottom-sheet--lane-band";

/** The track whose lane `selection`'s sheet must leave in view, or null. */
export function editedLaneTrack(selection: Selection): string | null {
  return selection?.kind === "envelope" || selection?.kind === "envelopePoint"
    ? selection.trackId
    : null;
}

export function compactSheetPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${COMPACT_SHEET_CLASS}`);
}

export function compactSheetSlot(): HTMLElement | null {
  return (
    compactSheetPanel()?.closest<HTMLElement>(".bottom-sheet-root") ?? null
  );
}

/** The open inspector sheet, compact, regular or the phone frame, or null when none is open. */
export function inspectorSheetPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.${INSPECTOR_SHEET_CLASS}, .${PHONE_SHEET_CLASS}`,
  );
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
 * Shortens the open inspector sheet to `height` px (null lifts the cap), for a
 * selection the page cannot scroll clear of it. The sheet's body keeps its own
 * scroll, and Expand still opens it in full.
 */
export function capInspectorSheet(height: number | null): void {
  const panel = inspectorSheetPanel();
  if (!panel) return;
  if (height === null) panel.style.removeProperty("--sheet-cap");
  else panel.style.setProperty("--sheet-cap", `${Math.round(height)}px`);
}

/**
 * The same for the band a lane-editing sheet leaves its lane. It has a cap of
 * its own, because the transcript's lifts `--sheet-cap` on every selection;
 * `bottom-sheet.css` honours the smaller of the two.
 */
export function capInspectorSheetForLane(height: number | null): void {
  const panel = inspectorSheetPanel();
  if (!panel) return;
  if (height === null) panel.style.removeProperty("--sheet-lane-cap");
  else panel.style.setProperty("--sheet-lane-cap", `${Math.round(height)}px`);
}

function holdsRow(spacePx: number, chromePx: number, rowPx: number): boolean {
  return !(spacePx > 0) || spacePx - chromePx >= rowPx;
}

export function halfDetentFits(
  slotPx: number,
  chromePx: number,
  rowPx: number,
): boolean {
  return holdsRow(slotPx / 2, chromePx, rowPx);
}

export function chromePins(
  slotPx: number,
  chromePx: number,
  rowPx: number,
): boolean {
  return holdsRow(slotPx, chromePx, rowPx);
}

export interface CompactSheetFit {
  halfFits: boolean;
  pinsChrome: boolean;
}

/**
 * The half detent is denied by the one-row header R-short-11 compacts to, not
 * by a header that wraps at large text, and only in a folded frame.
 */
export function measureCompactFit(folded: boolean): CompactSheetFit | null {
  const panel = compactSheetPanel();
  const slot = compactSheetSlot();
  const chrome = panel?.querySelector(".bottom-sheet-chrome");
  const header = panel?.querySelector(".bottom-sheet-header");
  const close = header?.querySelector(".dialog-close");
  if (!panel || !slot || !chrome || !header || !close) return null;
  const slotPx = slot.getBoundingClientRect().height;
  const headerPx = header.getBoundingClientRect().height;
  const chromePx =
    header.getBoundingClientRect().bottom - chrome.getBoundingClientRect().top;
  const headerStyle = getComputedStyle(header);
  const oneRowHeaderPx =
    Number.parseFloat(headerStyle.paddingTop) +
    Number.parseFloat(headerStyle.paddingBottom) +
    close.getBoundingClientRect().height;
  const rowPx = tokenHeightPx(panel, "--touch-min");
  return {
    halfFits:
      !folded ||
      halfDetentFits(slotPx, chromePx - headerPx + oneRowHeaderPx, rowPx),
    pinsChrome: chromePins(slotPx, chromePx, rowPx),
  };
}
