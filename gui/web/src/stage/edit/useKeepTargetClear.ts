/**
 * The phone Inspector sheet covers the lower part of a phone held upright, so
 * while it is open for a timeline target (a clip, a pending edit, an envelope
 * point, a chapter or an automatic-reduction band) this scrolls the target above
 * the sheet, and again whenever the sheet resizes (a detent, a rotation) or the
 * bands arrive. A timeline drag leaves the page where it is until release.
 */
import { useLayoutEffect, useSyncExternalStore } from "react";
import { clipBleedSession } from "../../edit/clipBleedSession";
import type { Selection } from "../../types/project";
import { inspectorSheetPanel } from "../../ui/compactSheet";
import { useResizeObserver } from "../../ui/useResizeObserver";
import { clearClearance, keepTargetClear } from "./keepTargetClear";

/** Selector of the band `selection` names, or of its clip before a band is picked. */
export function bandLocator(selection: Selection): string | null {
  if (selection?.kind !== "bleedAttenuation") return null;
  return selection.regionKey
    ? `[data-hit-kind="bleed-attenuation"][data-hit-id=${JSON.stringify(selection.regionKey)}]`
    : `[data-clip-id=${JSON.stringify(selection.id)}]`;
}

export function useKeepTargetClear(
  locate: string | null,
  paused = false,
): void {
  // The bands render once the session reads them; a new read re-aims the scroll.
  const snapshot = useSyncExternalStore(
    clipBleedSession.subscribe,
    clipBleedSession.getSnapshot,
    clipBleedSession.getSnapshot,
  );
  const active = locate !== null && !paused;
  useLayoutEffect(() => {
    if (active && locate) keepTargetClear(locate);
  }, [active, locate, snapshot]);
  useLayoutEffect(() => {
    if (!locate) return;
    return clearClearance;
  }, [locate]);
  useResizeObserver(
    inspectorSheetPanel,
    () => {
      if (active && locate) keepTargetClear(locate);
    },
    active,
  );
}
