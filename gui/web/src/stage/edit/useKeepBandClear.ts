/**
 * An automatic-reduction band is picked on the timeline, and its inspector is
 * the full sheet, not a peek strip: the session behind the bands lives in that
 * sheet's body, so a strip would close them. The sheet covers the lower part of
 * a phone held upright, so while it is open for a band this scrolls the band
 * above the sheet, as the peek strip does for a clip, and again whenever the
 * sheet resizes (a detent, a rotation) or the bands arrive.
 */
import { useLayoutEffect, useSyncExternalStore } from "react";
import { clipBleedSession } from "../../edit/clipBleedSession";
import type { Selection } from "../../types/project";
import { inspectorSheetPanel } from "../../ui/compactSheet";
import { useResizeObserver } from "../../ui/useResizeObserver";
import { keepTargetClear } from "./useCompactInspector";

/** Selector of the band `selection` names, or of its clip before a band is picked. */
export function bandLocator(selection: Selection): string | null {
  if (selection?.kind !== "bleedAttenuation") return null;
  return selection.regionKey
    ? `[data-hit-kind="bleed-attenuation"][data-hit-id=${JSON.stringify(selection.regionKey)}]`
    : `[data-clip-id=${JSON.stringify(selection.id)}]`;
}

function clearClearance(): void {
  for (const scroller of document.querySelectorAll<HTMLElement>(
    ".timeline-scroll",
  ))
    scroller.style.removeProperty("--sheet-clearance");
}

export function useKeepBandClear(locate: string | null): void {
  // The bands render once the session reads them; a new read re-aims the scroll.
  const snapshot = useSyncExternalStore(
    clipBleedSession.subscribe,
    clipBleedSession.getSnapshot,
    clipBleedSession.getSnapshot,
  );
  useLayoutEffect(() => {
    if (locate) keepTargetClear(locate);
  }, [locate, snapshot]);
  useLayoutEffect(() => {
    if (!locate) return;
    return clearClearance;
  }, [locate]);
  useResizeObserver(
    inspectorSheetPanel,
    () => {
      if (locate) keepTargetClear(locate);
    },
    locate !== null,
  );
}
