/**
 * A short screen (a phone held sideways) editing a lane's volume envelope has
 * room for the lane or the form, not both, unless the sheet leaves a band for
 * the lane. While the regular inspector sheet is open for `trackId`, this
 * scrolls that lane clear above the sheet and caps the sheet so the pinned
 * ruler and the whole lane stay visible; the sheet's body scrolls inside the
 * cap. With the software keyboard up the sheet takes the visible area instead.
 */
import { useLayoutEffect, useRef } from "react";
import {
  capInspectorSheetForLane,
  inspectorSheetBottom,
  inspectorSheetPanel,
} from "../../ui/compactSheet";
import { useResizeObserver } from "../../ui/useResizeObserver";
import { remToPx } from "../../utils/remToPx";
import {
  KEEP_CLEAR_PX,
  keepTargetClear,
  pinnedChromeBottom,
  useShortScreen,
} from "./useCompactInspector";

/** The cap never leaves the sheet less than its pinned header and a form row. */
const MIN_SHEET_REM = 9;

export const laneSelector = (trackId: string) =>
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
  const active = short && trackId !== null;
  const frame = useRef(0);
  // A rotation remounts the shell: the scroller and slot settle to their size
  // after the effect below, and the lane is brought back into view then. The
  // refit moves layout, so it runs a frame later: inside the observer's
  // callback it would raise "ResizeObserver loop completed" (WebKit).
  useResizeObserver(
    [
      () => (trackId ? document.querySelector(laneSelector(trackId)) : null),
      () => document.querySelector(".timeline-scroll"),
      () => document.querySelector(".bottom-sheet-root"),
    ],
    () => {
      if (trackId === null || frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        fit(trackId);
      });
    },
    active,
  );
  useLayoutEffect(() => {
    if (!short || trackId === null) return;
    fit(trackId);
    const keyboard = new MutationObserver(() => fit(trackId));
    keyboard.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-keyboard"],
    });
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      keyboard.disconnect();
      capInspectorSheetForLane(null);
      for (const scroller of document.querySelectorAll<HTMLElement>(
        ".timeline-scroll",
      ))
        scroller.style.removeProperty("--sheet-clearance");
    };
  }, [short, trackId]);
}
