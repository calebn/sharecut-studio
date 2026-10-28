import type { ReactNode } from "react";
import { isRangeSelection } from "../../edit/rangeSelection";
import {
  matchesMedia,
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../../hooks/useMediaQueryStore";
import { SelectionSheetBody } from "../../inspector/SelectionSheetBody";
import { opensSheet, type SheetScreen } from "../../inspector/selectionSurface";
import { inspectorOpenFor } from "../../state/selection";
import { useDaw } from "../../state/useDaw";
import type { Selection } from "../../types/project";
import type { SheetPlacement } from "../../ui/BottomSheet";
import {
  editedLaneTrack,
  INSPECTOR_SHEET_CLASS,
  LANE_BAND_SHEET_CLASS,
} from "../../ui/compactSheet";
import {
  type CompactSheetProps,
  compactSheetProps,
  useCompactInspector,
} from "./useCompactInspector";
import { useInspectorColumn } from "./useInspectorColumn";
import { bandLocator, useKeepBandClear } from "./useKeepBandClear";
import { useKeepEditedLaneClear } from "./useKeepEditedLaneClear";
import { useRevealEditedLane } from "./useRevealEditedLane";

/** The shells that carry a selection sheet. */
type SheetShell = "phone" | "tablet";

interface SheetOpenState {
  shell: SheetShell;
  selection: Selection;
  rangeArmed: boolean;
  /** What the Inspector was opened for (Inspect), or null. */
  inspectorKey: string | null;
  /** The surface the Edit stage shows. */
  screen: SheetScreen;
}

/**
 * Is the selection sheet open? One rule for every shell: Inspect opened it for
 * the selection still held (selecting alone never does), the selection's kind
 * lists the screens it opens on (`SELECTION_SURFACES`), and the phone and the
 * tablet each name the screen they show. Arming a range opens it alone, so the
 * In and Out fields sit in the bottom zone, never in a card at the top
 * (`docs/interaction-system.md` § Shells and placement, #1793). The tracks
 * ticked for the range are its scope, not a request to inspect them.
 */
function selectionSheetOpen(s: SheetOpenState): boolean {
  if (s.rangeArmed) return true;
  if (s.selection == null) return false;
  if (s.rangeArmed && s.selection.kind === "track") return false;
  return (
    inspectorOpenFor(s.selection, s.inspectorKey) &&
    opensSheet(s.selection, s.screen)
  );
}

export interface SelectionSheet {
  open: boolean;
  /** A bottom sheet, or a column on the inline end of a short landscape screen. */
  placement: SheetPlacement;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
  /** The panel's class when it is not the compact inspector; none in a column. */
  className: string;
  compact: CompactSheetProps | undefined;
  rangeActionsInSheet: boolean;
  /** Out of the way while a range is dragged out beneath it. */
  stowed: boolean;
  content: ReactNode;
}

const LANDSCAPE_MQ = "(orientation: landscape)";
const subscribeLandscape = mediaQuerySubscription([LANDSCAPE_MQ]);
const readLandscape = () => matchesMedia(LANDSCAPE_MQ);

/** The selection sheet for `shell`; closed for a shell without one. */
export function useSelectionSheet(
  shell: SheetShell | null,
  screen: SheetScreen,
): SelectionSheet {
  const column = useInspectorColumn();
  const compact = useCompactInspector(shell, column, screen === "timeline");
  const {
    selection,
    rangeArmed,
    sessionRegion,
    sheetExpanded,
    setSheetExpanded,
    setSelection,
    setRangeArmed,
    setInspectorOpen,
    inspectorKey,
    timelineDragging,
  } = useDaw((s) => ({
    selection: s.selection,
    inspectorKey: s.inspectorKey,
    setInspectorOpen: s.setInspectorOpen,
    rangeArmed: s.rangeArmed,
    sessionRegion: s.sessionRegion,
    sheetExpanded: s.sheetExpanded,
    setSheetExpanded: s.setSheetExpanded,
    setSelection: s.setSelection,
    setRangeArmed: s.setRangeArmed,
    timelineDragging: s.timelineDragging,
  }));
  const open =
    shell != null &&
    selectionSheetOpen({
      shell,
      selection,
      rangeArmed,
      inspectorKey,
      screen,
    });
  const landscape = useMediaQueryStore(
    subscribeLandscape,
    readLandscape,
    () => false,
  );
  // A phone in portrait has the rows to show the lane and the form; held
  // sideways it does not (#1714). The tablet shell keeps the lane band on any
  // short screen.
  // A side column leaves the lane its whole height instead (#1696).
  const laneBand = shell === "tablet" || (shell === "phone" && landscape);
  const laneTrack =
    open && laneBand && !compact && !column ? editedLaneTrack(selection) : null;
  useKeepEditedLaneClear(laneTrack);
  useKeepBandClear(open && !column && !compact ? bandLocator(selection) : null);
  useRevealEditedLane(open && column ? editedLaneTrack(selection) : null);
  const rangeActionsInSheet =
    open &&
    (rangeArmed ||
      isRangeSelection(selection) ||
      (shell === "tablet" && sessionRegion != null));
  return {
    open,
    placement: column ? "column" : "sheet",
    rangeActionsInSheet,
    stowed: !compact && timelineDragging && isRangeSelection(selection),
    expanded: sheetExpanded,
    onExpandedChange: setSheetExpanded,
    onClose: () => {
      // Close shuts the Inspector and keeps the selection (the bar still has
      // its verbs); an armed range was never a selection to keep.
      if (rangeArmed) setSelection(null);
      if (shell != null) setRangeArmed(false);
      setInspectorOpen(false);
      setSheetExpanded(false);
    },
    className: column
      ? ""
      : laneTrack === null
        ? INSPECTOR_SHEET_CLASS
        : `${INSPECTOR_SHEET_CLASS} ${LANE_BAND_SHEET_CLASS}`,
    compact: compact ? compactSheetProps(compact) : undefined,
    content: (
      <SelectionSheetBody
        rangeActionsInSheet={rangeActionsInSheet}
        peek={compact?.view === "peek" ? compact.peek : null}
      />
    ),
  };
}
