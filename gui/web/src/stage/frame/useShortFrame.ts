import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
} from "react";
import { useDawStore } from "../../state/dawStore";
import { useResizeObserver } from "../../ui/useResizeObserver";

/** The natural (unfolded) sizes the frame must fit, in px. */
export interface FrameFitSizes {
  frameHeight: number;
  headerHeight: number;
  playerHeight: number;
  tabsHeight: number;
  /** The Edit rows a fold moves into Tools (surface switch, tool strip); 0 off the phone's Edit. */
  rowsHeight: number;
  /** The lanes' own floor (`--stage-stacked-lanes-min`). */
  lanesMin: number;
  /** One lane (`--lane-height`): the corner may cover the foot of one. */
  laneHeight: number;
  /** The Edit lanes' column and the corner floating over its foot; 0 off Edit. */
  laneAreaHeight: number;
  cornerHeight: number;
}

/**
 * Whether the frame folds: it cannot hold its full header, the full Player,
 * the tab bar, the Edit rows and the lanes' floor together, or (on Edit) the corner would
 * cover more than the foot of one lane. A size that did not measure (NaN, or a
 * frame not laid out yet) never folds.
 */
export function frameFolds(sizes: FrameFitSizes): boolean {
  const {
    frameHeight,
    headerHeight,
    playerHeight,
    tabsHeight,
    rowsHeight,
    lanesMin,
    laneHeight,
    laneAreaHeight,
    cornerHeight,
  } = sizes;
  const need = headerHeight + playerHeight + tabsHeight + rowsHeight + lanesMin;
  if (!(frameHeight > 0) || Number.isNaN(need)) {
    return false;
  }
  if (frameHeight < need) {
    return true;
  }
  const covered = laneAreaHeight > 0 && cornerHeight > 0;
  return covered && laneAreaHeight - cornerHeight < lanesMin - laneHeight;
}

const FOLD_ATTRIBUTE = "frameShort";

/** A token's resolved block size in px: a `calc()` of tokens included. */
function tokenHeightPx(host: HTMLElement, token: string): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;inline-size:0;block-size:var(${token})`;
  host.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px;
}

/**
 * Measures the frame with the fold lifted, so the header, the Player and the
 * tab bar report their natural size whichever way the frame sits now. All
 * reads and the restore happen in one task, before any paint.
 */
function measureFit(frame: HTMLElement): FrameFitSizes {
  const root = document.documentElement;
  const folded = FOLD_ATTRIBUTE in root.dataset;
  if (folded) delete root.dataset[FOLD_ATTRIBUTE];
  const height = (selector: string) =>
    frame.querySelector(selector)?.getBoundingClientRect().height ?? 0;
  const sizes = {
    frameHeight: frame.getBoundingClientRect().height,
    headerHeight: height(".stage-frame-header"),
    playerHeight: height(".stage-frame-player"),
    tabsHeight: height(".stage-frame-tabs"),
    rowsHeight:
      height(".phone-edit-bar") + height(".phone-edit .edit-tool-strip"),
    lanesMin: tokenHeightPx(frame, "--stage-stacked-lanes-min"),
    laneHeight: tokenHeightPx(frame, "--lane-height"),
    laneAreaHeight: height(
      ".edit-workspace .edit-timeline-col, .phone-edit-lanes",
    ),
    cornerHeight: height(".edit-workspace .edit-corner"),
  };
  if (folded) root.dataset[FOLD_ATTRIBUTE] = "";
  return sizes;
}

/**
 * Writes `data-frame-short` on the root while the frame is folded: the tab bar
 * moves into the header's Stage menu, the Edit rows and corner into its Tools
 * button, and the Player becomes one touch-height row (system.css and
 * stage-frame.css key on the attribute). The fold is a measured fit
 * (`frameFolds`), so it tracks text size, header wrapping and the safe area
 * with no fixed threshold. Sheets live outside the frame and read the
 * attribute for their bottom offset. Returns whether the frame is folded, for
 * the header controls that exist only then.
 */
export function useShortFrame(frame: RefObject<HTMLElement | null>): boolean {
  const [short, setShort] = useState(false);
  const header = () => frame.current?.querySelector(".stage-frame-header");
  const player = () => frame.current?.querySelector(".stage-frame-player");
  // What a stage shows changes the fit (the Edit rows exist only on Edit) with
  // no resize of the frame, the header or the Player to report it.
  const shown = useDawStore((s) => `${s.stage}:${s.editSurface}`);
  const update = useEffectEvent(() => {
    const el = frame.current;
    if (!el) return;
    const folds = frameFolds(measureFit(el));
    const root = document.documentElement;
    setShort(folds);
    if (folds) root.dataset[FOLD_ATTRIBUTE] = "";
    else delete root.dataset[FOLD_ATTRIBUTE];
  });
  useResizeObserver([frame, header, player], update);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shown` is the trigger.
  useLayoutEffect(() => update(), [shown]);
  useEffect(
    () => () => {
      delete document.documentElement.dataset[FOLD_ATTRIBUTE];
    },
    [],
  );
  return short;
}
