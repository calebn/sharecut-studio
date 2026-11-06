import { useCallback } from "react";
import { isRangeSelection } from "../../edit/rangeSelection";
import { opensSheet, type SheetScreen } from "../../inspector/selectionSurface";
import { useDawStore } from "../../state/dawStore";
import { inspectorOpenFor } from "../../state/selection";
import { useDaw } from "../../state/useDaw";

export type InspectorShell = "desktop" | "tablet" | "phone";

export interface InspectorOpen {
  open: boolean;
  rangeActionsInSheet: boolean;
  close: () => void;
  /** The phone sheet dragged down past its dock: the selection goes too. */
  dismiss: () => void;
}

/**
 * Is the Inspector open? Inspect opened it for the selection still held
 * (selecting alone never does). The phone and the tablet also list the
 * screens a kind opens on, and arming a range opens them alone so the In and
 * Out fields sit in the bottom zone, never in a card at the top (#1793).
 */
export function useInspectorOpen(
  shell: InspectorShell,
  screen: SheetScreen,
): InspectorOpen {
  const { selection, rangeArmed, sessionRegion, inspectorKey } = useDaw(
    (s) => ({
      selection: s.selection,
      rangeArmed: s.rangeArmed,
      sessionRegion: s.sessionRegion,
      inspectorKey: s.inspectorKey,
    }),
  );
  const touch = shell !== "desktop";
  const open =
    (touch && rangeArmed) ||
    (selection != null &&
      inspectorOpenFor(selection, inspectorKey) &&
      (!touch || opensSheet(selection, screen)));
  const close = useCallback(() => {
    const s = useDawStore.getState();
    if (s.rangeArmed) s.setSelection(null);
    s.setRangeArmed(false);
    s.setInspectorOpen(false);
  }, []);
  const dismiss = useCallback(() => {
    const s = useDawStore.getState();
    s.setSelection(null);
    s.setRangeArmed(false);
    s.setInspectorOpen(false);
  }, []);
  return {
    open,
    rangeActionsInSheet:
      open &&
      (touch
        ? isRangeSelection(selection) ||
          rangeArmed ||
          (shell === "tablet" && sessionRegion != null)
        : isRangeSelection(selection)),
    close,
    dismiss,
  };
}
