import { type RefObject, useEffect, useState } from "react";
import { useResizeObserver } from "../../ui/useResizeObserver";

/**
 * Writes `data-frame-short` on the root while the tab bar is folded into the
 * header (`@container app (max-height: 16rem)` in system.css hides it). Sheets
 * live outside the frame and read the attribute for their bottom offset
 * (stage-frame.css). The tab bar's own size change is the signal, so the
 * threshold stays in the one query. Returns whether the frame is short, for the
 * header controls that exist only then.
 */
export function useShortFrame(frame: RefObject<HTMLElement | null>): boolean {
  const [short, setShort] = useState(false);
  const tabs = () => frame.current?.querySelector(".stage-frame-tabs");
  const update = () => {
    const bar = tabs();
    const folded = bar && getComputedStyle(bar).display === "none";
    const root = document.documentElement;
    setShort(Boolean(folded));
    if (folded) root.dataset.frameShort = "";
    else delete root.dataset.frameShort;
  };
  useResizeObserver([frame, tabs], update);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.frameShort;
    },
    [],
  );
  return short;
}
