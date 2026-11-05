/**
 * The compact inspector (#1051 rounds 3 and 4b): on a phone-sized screen a
 * timeline selection opens the Inspector as a drawer at half or full height.
 * The user's last choice opens the next selection (`compactInspectorView`,
 * persisted, half by default). The selected target stays in view above the
 * sheet, and any timeline drag stows it until release.
 *
 * Only the phone shell's Timeline mode uses the drawer; the tablet and the
 * desktop open the Inspector card (`InspectorHost`).
 */
import {
  type ComponentProps,
  createElement,
  useLayoutEffect,
  useState,
} from "react";
import {
  matchesMedia,
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../../hooks/useMediaQueryStore";
import { useDaw } from "../../state/useDaw";
import type { Selection } from "../../types/project";
import type { BottomSheet } from "../../ui/BottomSheet";
import {
  CHROME_SCROLLS_CLASS,
  COMPACT_SHEET_CLASS,
  type CompactSheetFit,
  compactSheetPanel,
  compactSheetSlot,
  INSPECTOR_SHEET_CLASS,
  inspectorSheetPanel,
  inspectorSheetTop,
  measureCompactFit,
} from "../../ui/compactSheet";
import { DRAWER_MOTION_ATTR } from "../../ui/useDrawerSwipe";
import { useResizeObserver } from "../../ui/useResizeObserver";
import {
  COMPACT_INSPECTOR_VIEWS,
  type CompactInspectorView,
} from "../../utils/compactInspectorPref";
import { CompactHistoryControls } from "../frame/HistoryControls";
import { isFrameFolded } from "../frame/useShortFrame";
import { type CompactTarget, compactTarget } from "./compactTarget";

const FULL_ONLY_VIEWS: readonly CompactInspectorView[] = ["full"];

/** A phone held sideways: the same short-screen line the sheets use. */
export const SHORT_SCREEN_MQ = "(max-height: 40rem)";
/** Gap kept between the selected target and the sheet (px). */
export const KEEP_CLEAR_PX = 8;

const subscribeShort = mediaQuerySubscription([SHORT_SCREEN_MQ]);
const readShort = () => matchesMedia(SHORT_SCREEN_MQ);

export function useShortScreen(): boolean {
  return useMediaQueryStore(subscribeShort, readShort, () => false);
}

interface CompactInspector {
  target: CompactTarget;
  view: CompactInspectorView;
  detents: readonly CompactInspectorView[];
  pinsChrome: boolean;
  stowed: boolean;
  setView: (view: CompactInspectorView) => void;
}

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
 * compact sheet; the scroller gets bottom padding as deep as the sheet covers
 * it, so a target on the last lane can still rise above it.
 */
export function keepTargetClear(locate: string): void {
  const target = document.querySelector(locate);
  const scroller = target?.closest<HTMLElement>(".timeline-scroll");
  const panel = inspectorSheetPanel();
  const sheetTop = inspectorSheetTop();
  if (!target || !scroller || !panel || sheetTop === null) return;
  // A moving drawer fills its slot; the clearance waits for it to rest.
  if (panel.hasAttribute(DRAWER_MOTION_ATTR)) return;
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

function clearClearance(): void {
  for (const scroller of document.querySelectorAll<HTMLElement>(
    ".timeline-scroll",
  )) {
    scroller.style.removeProperty("--sheet-clearance");
  }
}

/**
 * The compact inspector on the phone shell's Timeline mode, or null where the
 * Inspector sheet applies.
 */
export function useCompactInspector(
  phone: boolean,
  /** Whether the lanes are on screen (the phone also has the Script). */
  timelineShown: boolean,
): CompactInspector | null {
  const {
    project,
    selection,
    hit,
    view,
    stowed,
    setView,
    inspectorSelection,
    rangeArmed,
  } = useDaw((s) => ({
    project: s.project,
    selection: s.selection,
    hit: s.selectionHit,
    view: s.compactInspectorView,
    stowed: s.timelineDragging,
    setView: s.setCompactInspectorView,
    inspectorSelection: s.inspectorSelection,
    rangeArmed: s.rangeArmed,
  }));
  // Armed, the regular sheet carries the In and Out fields at full size.
  const applies = phone && timelineShown && !rangeArmed;
  const candidate =
    applies && project ? compactTarget(project, selection, hit) : null;
  const [seen, setSeen] = useState<{
    selection: Selection;
    plain: boolean;
    held: boolean;
  }>({ selection: null, plain: false, held: false });
  let held = seen.held;
  if (seen.selection !== selection) {
    held =
      selection != null &&
      selection === inspectorSelection &&
      (seen.held || (candidate != null && seen.plain));
    setSeen({
      selection,
      held,
      plain: applies && selection != null && (held || candidate == null),
    });
  }
  const target = held ? null : candidate;
  const locate = target?.locate ?? null;

  const active = locate != null && !stowed;
  const [fit, setFit] = useState<CompactSheetFit>({
    halfFits: true,
    pinsChrome: true,
  });
  useResizeObserver(
    [
      () => (target ? compactSheetSlot() : null),
      () =>
        target
          ? compactSheetPanel()?.querySelector(".bottom-sheet-header")
          : null,
    ],
    () => {
      const next = measureCompactFit(isFrameFolded());
      if (next) {
        setFit((now) =>
          now.halfFits === next.halfFits && now.pinsChrome === next.pinsChrome
            ? now
            : next,
        );
      }
    },
  );
  // `view` re-runs it: half and full cover different depths.
  useLayoutEffect(() => {
    if (active && locate && view) keepTargetClear(locate);
  }, [active, locate, view]);
  // The sheet's height settles after its content does (inspector fields).
  useResizeObserver(
    compactSheetPanel,
    () => {
      if (active && locate) keepTargetClear(locate);
    },
    active,
  );
  useLayoutEffect(() => {
    if (!locate) return;
    return clearClearance;
  }, [locate]);

  const shown = view === "half" && !fit.halfFits ? "full" : view;
  return target
    ? {
        target,
        view: shown,
        detents: fit.halfFits ? COMPACT_INSPECTOR_VIEWS : FULL_ONLY_VIEWS,
        pinsChrome: fit.pinsChrome,
        stowed,
        setView,
      }
    : null;
}

/** `BottomSheet` props that make the inspector sheet the compact one. */
export type CompactSheetProps = Pick<
  ComponentProps<typeof BottomSheet>,
  "title" | "drawer" | "stowed" | "className" | "compactHeaderActions"
>;

/**
 * The compact inspector is a swipeable drawer (#1051 round 4b): the full
 * inspector at half and full height. It keeps the target's name at every
 * detent.
 */
export function compactSheetProps(
  compact: CompactInspector,
): CompactSheetProps {
  return {
    title: compact.target.title,
    compactHeaderActions: createElement(CompactHistoryControls),
    drawer: {
      detents: compact.detents,
      detent: compact.view,
      // The drawer offers half and full only, so a detent is one of the two.
      onDetentChange: (detent) =>
        compact.setView(detent === "full" ? "full" : "half"),
      label: "Inspector height",
    },
    stowed: compact.stowed,
    className: `${INSPECTOR_SHEET_CLASS} ${COMPACT_SHEET_CLASS}${compact.pinsChrome ? "" : ` ${CHROME_SCROLLS_CLASS}`}`,
  };
}
