/**
 * Keeps a selected timeline target in view above the phone Inspector sheet:
 * the sheet covers the lower part of a phone held upright, so the scroller
 * moves the target up and gets bottom padding as deep as the sheet covers it.
 */
import { inspectorSheetPanel, inspectorSheetTop } from "../../ui/compactSheet";

/** A phone held sideways: the same short-screen line the sheets use. */
export const SHORT_SCREEN_MQ = "(max-height: 40rem)";
/** Gap kept between the selected target and the sheet (px). */
const KEEP_CLEAR_PX = 8;

/**
 * Where a timeline scroller's pinned chrome ends: under the marker rows, or
 * under the ruler alone while a lane-editing sheet lets the rows scroll.
 */
export function pinnedChromeBottom(scroller: HTMLElement): number {
  const markers = scroller.querySelector(".marker-lane");
  if (markers && getComputedStyle(markers).position === "sticky")
    return markers.getBoundingClientRect().bottom;
  return (
    scroller.querySelector(".timeline-ruler")?.getBoundingClientRect().bottom ??
    scroller.getBoundingClientRect().top
  );
}

/**
 * Scrolls `locate`'s element, inside its timeline scroller, clear of the
 * Inspector sheet; the scroller gets bottom padding as deep as the sheet covers
 * it, so a target on the last lane can still rise above it.
 */
export function keepTargetClear(locate: string): void {
  const target = document.querySelector(locate);
  const scroller = target?.closest<HTMLElement>(".timeline-scroll");
  const panel = inspectorSheetPanel();
  const sheetTop = inspectorSheetTop();
  if (!target || !scroller || !panel || sheetTop === null) return;
  const box = scroller.getBoundingClientRect();
  scroller.style.setProperty(
    "--sheet-clearance",
    `${Math.max(0, Math.round(box.bottom - sheetTop))}px`,
  );
  const chrome = pinnedChromeBottom(scroller);
  const r = target.getBoundingClientRect();
  const delta = Math.min(r.bottom - (sheetTop - KEEP_CLEAR_PX), r.top - chrome);
  if (delta > 0) scroller.scrollTop += delta;
}

export function clearClearance(): void {
  for (const scroller of document.querySelectorAll<HTMLElement>(
    ".timeline-scroll",
  )) {
    scroller.style.removeProperty("--sheet-clearance");
  }
}
