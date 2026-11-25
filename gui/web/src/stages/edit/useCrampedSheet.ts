import { useEffect, useState } from "react";
import { useResizeObserver } from "../../ui/useResizeObserver";

const SHORT_REM = 40;
const CRAMPED_REM = 22;

/** The viewport height in root em, so large text counts: a rem media query ignores a root font size set by the page. */
function viewportRem(): number {
  const size = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  return window.innerHeight / (size > 0 ? size : 16);
}

/** A short screen opens the sheet full: the half detent leaves the form little room beside the pinned footer. */
export const opensFull = () => viewportRem() < SHORT_REM;

/** Whether the screen is so short, in rem, that a pinned footer would leave the form no height (large text on a small phone). */
export function useCrampedSheet(): boolean {
  const [cramped, setCramped] = useState(() => viewportRem() < CRAMPED_REM);
  const [probe, setProbe] = useState<HTMLElement | null>(null);
  const measure = () => setCramped(viewportRem() < CRAMPED_REM);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  // A probe one rem wide resizes when the text size changes, which fires no window event.
  useEffect(() => {
    const element = document.createElement("div");
    element.setAttribute("aria-hidden", "true");
    element.style.cssText =
      "position:fixed;inline-size:1rem;block-size:0;visibility:hidden;pointer-events:none";
    document.body.append(element);
    setProbe(element);
    return () => element.remove();
  }, []);
  useResizeObserver(probe, measure);
  return cramped;
}
