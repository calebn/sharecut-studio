/**
 * The compact inspector (#1051 round 3): on a phone-sized
 * screen a timeline selection opens a peek strip instead of a sheet that
 * covers the timeline. The user's last choice, strip or expanded inspector,
 * opens the next selection (`compactInspectorView`, persisted). Strip or
 * sheet, the selected target stays in view above it, and any timeline drag
 * stows it until release.
 *
 * The phone shell's Timeline mode and the tablet shell, upright or sideways,
 * peek alike (#1871): a mid-height sheet over a tall iPad timeline hid the
 * pressed clip. Where the Inspector is a side column (#1696) there is no
 * sheet to peek from.
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
import { type PeekTarget, peekTarget } from "../../inspector/peekTarget";
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

const FULL_ONLY_VIEWS: readonly CompactInspectorView[] = ["peek", "full"];

/** A phone held sideways: the same short-screen line the sheets use. */
export const SHORT_SCREEN_MQ = "(max-height: 40rem)";
/** Gap kept between the selected target and the strip or sheet (px). */
export const KEEP_CLEAR_PX = 8;

const subscribeShort = mediaQuerySubscription([SHORT_SCREEN_MQ]);
const readShort = () => matchesMedia(SHORT_SCREEN_MQ);

export function useShortScreen(): boolean {
  return useMediaQueryStore(subscribeShort, readShort, () => false);
}

interface CompactInspector {
  peek: PeekTarget;
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
 * The compact inspector for `shell` (Timeline mode on the phone shell, or the
 * tablet shell; null for the desktop shell), or null where the usual
 * sheet or the side `column` applies.
 */
export function useCompactInspector(
  shell: "phone" | "tablet" | null,
  column: boolean,
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
  // Armed, the sheet carries the In and Out fields at full size, not a strip.
  const applies =
    !column &&
    !rangeArmed &&
    (shell === "phone" ? timelineShown : shell === "tablet");
  const candidate =
    applies && project ? peekTarget(project, selection, hit) : null;
  const [seen, setSeen] = useState<{
    selection: Selection;
    plain: boolean;
    held: boolean;
  }>({ selection: null, plain: false, held: false });
  // The column already shows the full Inspector, so turning upright keeps it
  // for that selection instead of folding it into the strip.
  const inColumn = column && selection != null;
  let held = seen.held;
  if (seen.selection !== selection || (inColumn && !seen.held)) {
    held =
      inColumn ||
      (selection != null &&
        selection === inspectorSelection &&
        (seen.held || (candidate != null && seen.plain)));
    setSeen({
      selection,
      held,
      plain: applies && selection != null && (held || candidate == null),
    });
  }
  const peek = held ? null : candidate;
  const locate = peek?.locate ?? null;

  const active = locate != null && !stowed;
  const [fit, setFit] = useState<CompactSheetFit>({
    halfFits: true,
    pinsChrome: true,
  });
  useResizeObserver(
    [
      () => (peek ? compactSheetSlot() : null),
      () =>
        peek
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
  // `view` re-runs it: the strip and the sheet cover different depths.
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
  return peek
    ? {
        peek,
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
 * The compact inspector is a swipeable drawer (#1051 round 4b): the strip at
 * peek, the full inspector at half and full height. It keeps the target's
 * name at every detent.
 */
export function compactSheetProps(
  compact: CompactInspector,
): CompactSheetProps {
  return {
    title: compact.peek.title,
    compactHeaderActions: createElement(CompactHistoryControls),
    drawer: {
      detents: compact.detents,
      detent: compact.view,
      onDetentChange: compact.setView,
      label: "Inspector height",
    },
    stowed: compact.stowed,
    className: `${INSPECTOR_SHEET_CLASS} ${COMPACT_SHEET_CLASS}${compact.pinsChrome ? "" : ` ${CHROME_SCROLLS_CLASS}`}`,
  };
}
