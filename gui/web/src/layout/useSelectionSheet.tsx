import type { ReactNode } from "react";
import { isRangeSelection } from "../edit/rangeSelection";
import { SelectionSheetBody } from "../inspector/SelectionSheetBody";
import { opensPhoneSheet, sheetScreen } from "../inspector/selectionSurface";
import type {
  LayoutMode,
  MobileMode,
  MoreDestination,
  ShellBreakpoint,
} from "../state/types";
import { useDaw } from "../state/useDaw";
import type { Selection } from "../types/project";
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
import { useKeepEditedLaneClear } from "./useKeepEditedLaneClear";

/**
 * The shells that carry a selection sheet. `armedOpens`: Select range alone
 * opens it, because the phone has no bar for the In and Out fields. Where it
 * does not, the fields sit in the transport bar until a selection opens the
 * sheet.
 */
export const SHEET_SHELLS = {
  phone: { armedOpens: true },
  tablet: { armedOpens: false },
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

/** Is the selection sheet open? One rule for every shell. */
export function selectionSheetOpen(s: SheetOpenState): boolean {
  if (s.shell === "desktop") return false;
  if (s.shell === "phone") {
    return (
      s.rangeArmed ||
      (s.selection != null &&
        opensPhoneSheet(
          s.selection,
          sheetScreen(s.mobileMode, s.moreDestination),
        ))
    );
  }
  // Text and review focus expand the bottom band the peek sheet shares.
  return (
    s.selection != null && s.layoutMode !== "text" && s.layoutMode !== "review"
  );
}

export interface SelectionSheet {
  open: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
  /** The panel's class when it is not the compact inspector. */
  className: string;
  compact: CompactSheetProps | undefined;
  /** The editing rail is inert while a full-height compact sheet covers it. */
  coversTools: boolean;
  rangeActionsInSheet: boolean;
  content: ReactNode;
}

/** The selection sheet for `shell`; closed for a shell without one. */
export function useSelectionSheet(shell: SheetShell | null): SelectionSheet {
  const compact = useCompactInspector(shell);
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
  const laneTrack =
    open && shell != null && !compact ? editedLaneTrack(selection) : null;
  useKeepEditedLaneClear(laneTrack);
  const armedOpens = shell != null && SHEET_SHELLS[shell].armedOpens;
  const rangeActionsInSheet =
    open &&
    (rangeArmed ||
      isRangeSelection(selection) ||
      (shell === "tablet" && sessionRegion != null));
  return {
    open,
    rangeActionsInSheet,
    expanded: sheetExpanded,
    onExpandedChange: setSheetExpanded,
    onClose: () => {
      if (armedOpens) setRangeArmed(false);
      setSelection(null);
      setSheetExpanded(false);
    },
    className:
      laneTrack === null
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
