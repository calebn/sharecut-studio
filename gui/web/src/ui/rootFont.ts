import { DEFAULT_REM_PX } from "../system/rulerMath";

/** A zero-height box one rem wide: it resizes when the root text size changes, which `resize` does not report. */
export function makeRemProbe(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;inline-size:1rem;block-size:0";
  return el;
}

/** The root font size in px, for room figured in rem. */
export function rootFontPx(): number {
  const size = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  return size > 0 ? size : DEFAULT_REM_PX;
}
