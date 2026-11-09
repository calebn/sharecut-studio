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
 * screens a kind opens on. A range draft opens it on every shell with nothing
 * selected, so the In and Out fields sit in the bottom zone on touch, never in a
 * card at the top (#1793).
 */
export function useInspectorOpen(
  shell: InspectorShell,
  screen: SheetScreen,
): InspectorOpen {
  const { selection, rangeArmed, rangeDraft, sessionRegion, inspectorKey } =
    useDaw((s) => ({
      selection: s.selection,
      rangeArmed: s.rangeArmed,
      rangeDraft: s.rangeDraft,
      sessionRegion: s.sessionRegion,
      inspectorKey: s.inspectorKey,
    }));
  const touch = shell !== "desktop";
  const drafting =
    rangeArmed && rangeDraft != null && !isRangeSelection(selection);
  const open =
    drafting ||
    (selection != null &&
      inspectorOpenFor(selection, inspectorKey) &&
      (!touch || opensSheet(selection, screen)));
  const close = useCallback(() => {
    const s = useDawStore.getState();
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
      (drafting ||
        (touch
          ? isRangeSelection(selection) ||
            rangeArmed ||
            (shell === "tablet" && sessionRegion != null)
          : isRangeSelection(selection))),
    close,
    dismiss,
  };
}
