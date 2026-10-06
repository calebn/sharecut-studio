/**
 * The compact inspector (#1051 round 3, lab `touchChooser`): on a phone-sized
 * screen a timeline selection opens a peek strip instead of a sheet that
 * covers the timeline. The user's last choice, strip or expanded inspector,
 * opens the next selection (`compactInspectorView`, persisted). Strip or
 * sheet, the selected target stays in view above it, and any timeline drag
 * stows it until release.
 *
 * Phone-sized: the phone shell's Timeline mode, or the tablet shell on a
 * short screen (a phone held sideways). Real tablets keep their sheet.
 */
import { type ComponentProps, useLayoutEffect } from "react";
import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../hooks/useMediaQueryStore";
import { type PeekTarget, peekTarget } from "../inspector/peekTarget";
import { useDaw } from "../state/useDaw";
import type { BottomSheet } from "../ui/BottomSheet";
import { useResizeObserver } from "../ui/useResizeObserver";
import type { CompactInspectorView } from "../utils/compactInspectorPref";
import { useLabFlag } from "../utils/labFlags";

/** A phone held sideways: the same short-screen line the sheets use. */
export const SHORT_SCREEN_MQ = "(max-height: 40rem)";
/** Gap kept between the selected target and the strip or sheet (px). */
export const KEEP_CLEAR_PX = 8;

const subscribeShort = mediaQuerySubscription([SHORT_SCREEN_MQ]);
const readShort = () =>
  typeof globalThis.matchMedia === "function" &&
  globalThis.matchMedia(SHORT_SCREEN_MQ).matches;

export interface CompactInspector {
  peek: PeekTarget;
  view: CompactInspectorView;
  stowed: boolean;
  setView: (view: CompactInspectorView) => void;
}

/**
 * Scrolls `locate`'s element, inside its timeline scroller, clear of the
 * compact sheet; the scroller gets bottom padding as deep as the sheet covers
 * it, so a target on the last lane can still rise above it.
 */
export function keepTargetClear(locate: string): void {
  const target = document.querySelector(locate);
  const scroller = target?.closest<HTMLElement>(".timeline-scroll");
  const panel = document.querySelector<HTMLElement>(".bottom-sheet--compact");
  const root = panel?.closest(".bottom-sheet-root");
  if (!target || !scroller || !panel || !root) return;
  // The panel's resting top: its entrance animation moves the drawn box.
  const sheetTop = root.getBoundingClientRect().bottom - panel.offsetHeight;
  const box = scroller.getBoundingClientRect();
  scroller.style.setProperty(
    "--sheet-clearance",
    `${Math.max(0, Math.round(box.bottom - sheetTop))}px`,
  );
  const chrome =
    scroller.querySelector(".marker-lane")?.getBoundingClientRect().bottom ??
    box.top;
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
 * The compact inspector for `shell` (Timeline mode on the phone shell, or a
 * short tablet shell; null for the desktop shell), or null where the usual
 * sheet applies.
 */
export function useCompactInspector(
  shell: "phone" | "tablet" | null,
): CompactInspector | null {
  const lab = useLabFlag("touchChooser");
  const short = useMediaQueryStore(subscribeShort, readShort, () => false);
  const { project, selection, hit, view, stowed, mobileMode, setView } = useDaw(
    (s) => ({
      project: s.project,
      selection: s.selection,
      hit: s.selectionHit,
      view: s.compactInspectorView,
      stowed: s.timelineDragging,
      mobileMode: s.mobileMode,
      setView: s.setCompactInspectorView,
    }),
  );
  const applies =
    lab &&
    (shell === "phone"
      ? mobileMode === "timeline"
      : shell === "tablet" && short);
  const peek = applies && project ? peekTarget(project, selection, hit) : null;
  const locate = peek?.locate ?? null;

  const active = locate != null && !stowed;
  // `view` re-runs it: the strip and the sheet cover different depths.
  useLayoutEffect(() => {
    if (active && locate && view) keepTargetClear(locate);
  }, [active, locate, view]);
  // The sheet's height settles after its content does (inspector fields).
  useResizeObserver(
    () => document.querySelector(".bottom-sheet--compact"),
    () => {
      if (active && locate) keepTargetClear(locate);
    },
    active,
  );
  useLayoutEffect(() => {
    if (!locate) return;
    return clearClearance;
  }, [locate]);

  return peek ? { peek, view, stowed, setView } : null;
}

/** `BottomSheet` props that make the inspector sheet the compact one. */
export type CompactSheetProps = Pick<
  ComponentProps<typeof BottomSheet>,
  | "title"
  | "size"
  | "expandedSize"
  | "expanded"
  | "onExpandedChange"
  | "resizeLabels"
  | "stowed"
  | "className"
>;

export function compactSheetProps(
  compact: CompactInspector,
): CompactSheetProps {
  return {
    title: compact.view === "strip" ? compact.peek.title : "Inspector",
    size: "peek",
    expandedSize: "half",
    expanded: compact.view === "inspector",
    onExpandedChange: (expanded) =>
      compact.setView(expanded ? "inspector" : "strip"),
    resizeLabels: {
      expand: "Expand to the full inspector",
      collapse: "Collapse to the strip",
    },
    stowed: compact.stowed,
    className: "bottom-sheet--compact",
  };
}
