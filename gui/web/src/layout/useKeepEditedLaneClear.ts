/**
 * A short screen (a phone held sideways) editing a lane's volume envelope has
 * room for the lane or the form, not both, unless the sheet leaves a band for
 * the lane. While the regular inspector sheet is open for `trackId`, this
 * scrolls that lane clear above the sheet and caps the sheet so the pinned
 * ruler and the whole lane stay visible; the sheet's body scrolls inside the
 * cap. With the software keyboard up the sheet takes the visible area instead.
 */
import { useLayoutEffect } from "react";
import { remToPx } from "../hooks/useTabsHeight";
import {
  capInspectorSheetForLane,
  inspectorSheetBottom,
  inspectorSheetPanel,
} from "../ui/compactSheet";
import {
  KEEP_CLEAR_PX,
  keepTargetClear,
  pinnedChromeBottom,
  useShortScreen,
} from "./useCompactInspector";

/** The cap never leaves the sheet less than its pinned header and a form row. */
const MIN_SHEET_REM = 9;

const laneSelector = (trackId: string) =>
  `.lane-row[data-track-id=${JSON.stringify(trackId)}]`;

function fit(trackId: string): void {
  if (document.documentElement.dataset.keyboard === "open") return;
  const locate = laneSelector(trackId);
  const lane = document.querySelector(locate);
  const scroller = lane?.closest<HTMLElement>(".timeline-scroll");
  const slotBottom = inspectorSheetBottom();
  if (!lane || !scroller || slotBottom === null) return;
  const pinnedBottom = pinnedChromeBottom(scroller);
  const band =
    pinnedBottom + lane.getBoundingClientRect().height + KEEP_CLEAR_PX;
  capInspectorSheetForLane(Math.max(remToPx(MIN_SHEET_REM), slotBottom - band));
  keepTargetClear(locate);
  // keepTargetClear only lifts a target off the sheet; a lane scrolled under
  // the pinned ruler comes back down to sit just below it.
  const hidden = pinnedBottom - lane.getBoundingClientRect().top;
  if (hidden > 0) scroller.scrollTop -= hidden;
  revealOpenForm();
}

/** A resize leaves the sheet's own scroll where it was; keep the open form in it. */
function revealOpenForm(): void {
  const form = inspectorSheetPanel()?.querySelector("form");
  const body = form?.closest<HTMLElement>(".modifier-body");
  if (!form || !body) return;
  const below =
    form.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom;
  if (below > 0) body.scrollTop += below;
}

export function useKeepEditedLaneClear(trackId: string | null): void {
  const short = useShortScreen();
  useLayoutEffect(() => {
    if (!short || trackId === null) return;
    fit(trackId);
    const onResize = () => fit(trackId);
    window.addEventListener("resize", onResize);
    // A rotation remounts the shell: the scroller and slot settle to their
    // size after this effect, and the lane is brought back into view then.
    const settle = new ResizeObserver(onResize);
    for (const element of document.querySelectorAll(
      `${laneSelector(trackId)}, .timeline-scroll, .bottom-sheet-root`,
    ))
      settle.observe(element);
    const keyboard = new MutationObserver(onResize);
    keyboard.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-keyboard"],
    });
    return () => {
      window.removeEventListener("resize", onResize);
      settle.disconnect();
      keyboard.disconnect();
      capInspectorSheetForLane(null);
      for (const scroller of document.querySelectorAll<HTMLElement>(
        ".timeline-scroll",
      ))
        scroller.style.removeProperty("--sheet-clearance");
    };
  }, [short, trackId]);
}
