import type { ReactNode } from "react";
import { isRangeSelection } from "../edit/rangeSelection";
import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../hooks/useMediaQueryStore";
import { SelectionSheetBody } from "../inspector/SelectionSheetBody";
import {
  layoutScreen,
  opensSheet,
  type SheetScreen,
  sheetScreen,
} from "../inspector/selectionSurface";
import type {
  LayoutMode,
  MobileMode,
  MoreDestination,
  ShellBreakpoint,
} from "../state/types";
import { useDaw } from "../state/useDaw";
import type { Selection } from "../types/project";
import type { SheetPlacement } from "../ui/BottomSheet";
import {
  editedLaneTrack,
  INSPECTOR_SHEET_CLASS,
  LANE_BAND_SHEET_CLASS,
} from "../ui/compactSheet";
import {
  type CompactSheetProps,
  compactSheetProps,
  useCompactInspector,
} from "./useCompactInspector";
import { useInspectorColumn } from "./useInspectorColumn";
import { bandLocator, useKeepBandClear } from "./useKeepBandClear";
import { useKeepEditedLaneClear } from "./useKeepEditedLaneClear";
import { useRevealEditedLane } from "./useRevealEditedLane";

/**
 * The shells that carry a selection sheet. `armedOpens`: Select range alone
 * opens it, with the In and Out fields in the bottom zone. Doing controls
 * never sit in a card at the top (`docs/interaction-system.md` § Shells and
 * placement), so the tablet does it too (#1793).
 */
export const SHEET_SHELLS = {
  phone: { armedOpens: true },
  tablet: { armedOpens: true },
} as const satisfies Partial<Record<ShellBreakpoint, { armedOpens: boolean }>>;

export type SheetShell = keyof typeof SHEET_SHELLS;

export interface SheetOpenState {
  shell: ShellBreakpoint;
  selection: Selection;
  rangeArmed: boolean;
  layoutMode: LayoutMode;
  mobileMode: MobileMode;
  moreDestination: MoreDestination;
}

/** The screen the shell shows: the phone's mode, the tablet's layout. */
function shownScreen(s: SheetOpenState): SheetScreen | null {
  return s.shell === "phone"
    ? sheetScreen(s.mobileMode, s.moreDestination)
    : layoutScreen(s.layoutMode);
}

/**
 * Is the selection sheet open? One rule for every shell: the selection's kind
 * lists the screens it opens on (`SELECTION_SURFACES`), and the phone and the
 * tablet each name the screen they show. Arming a range opens it alone, so the
 * In and Out fields sit in the sheet. The tracks ticked for the range are its
 * scope, not a request to inspect them.
 */
export function selectionSheetOpen(s: SheetOpenState): boolean {
  if (s.shell === "desktop") return false;
  const { armedOpens } = SHEET_SHELLS[s.shell];
  if (s.rangeArmed && armedOpens) return true;
  if (s.selection == null) return false;
  if (s.rangeArmed && s.selection.kind === "track") return false;
  return opensSheet(s.selection, shownScreen(s));
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
  /** The editing rail is inert while a full-height compact sheet covers it. */
  coversTools: boolean;
  rangeActionsInSheet: boolean;
  content: ReactNode;
}

const LANDSCAPE_MQ = "(orientation: landscape)";
const subscribeLandscape = mediaQuerySubscription([LANDSCAPE_MQ]);
const readLandscape = () =>
  typeof globalThis.matchMedia === "function" &&
  globalThis.matchMedia(LANDSCAPE_MQ).matches;

/** The selection sheet for `shell`; closed for a shell without one. */
export function useSelectionSheet(shell: SheetShell | null): SelectionSheet {
  const column = useInspectorColumn();
  const compact = useCompactInspector(shell, column);
  const {
    selection,
    rangeArmed,
    sessionRegion,
    layoutMode,
    mobileMode,
    moreDestination,
    sheetExpanded,
    setSheetExpanded,
    setSelection,
    setRangeArmed,
  } = useDaw((s) => ({
    selection: s.selection,
    rangeArmed: s.rangeArmed,
    sessionRegion: s.sessionRegion,
    layoutMode: s.layoutMode,
    mobileMode: s.mobileMode,
    moreDestination: s.moreDestination,
    sheetExpanded: s.sheetExpanded,
    setSheetExpanded: s.setSheetExpanded,
    setSelection: s.setSelection,
    setRangeArmed: s.setRangeArmed,
  }));
  const open =
    shell != null &&
    selectionSheetOpen({
      shell,
      selection,
      rangeArmed,
      layoutMode,
      mobileMode,
      moreDestination,
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
  const armedOpens = shell != null && SHEET_SHELLS[shell].armedOpens;
  const rangeActionsInSheet =
    open &&
    (rangeArmed ||
      isRangeSelection(selection) ||
      (shell === "tablet" && sessionRegion != null));
  return {
    open,
    placement: column ? "column" : "sheet",
    rangeActionsInSheet,
    expanded: sheetExpanded,
    onExpandedChange: setSheetExpanded,
    onClose: () => {
      if (armedOpens) setRangeArmed(false);
      setSelection(null);
      setSheetExpanded(false);
    },
    className: column
      ? ""
      : laneTrack === null
        ? INSPECTOR_SHEET_CLASS
        : `${INSPECTOR_SHEET_CLASS} ${LANE_BAND_SHEET_CLASS}`,
    compact: compact ? compactSheetProps(compact) : undefined,
    coversTools: open && compact != null && !compact.stowed,
    content: (
      <SelectionSheetBody
        rangeActionsInSheet={rangeActionsInSheet}
        peek={compact?.view === "peek" ? compact.peek : null}
      />
    ),
  };
}
