import { useSyncExternalStore } from "react";
import { DEFAULT_REM_PX } from "../system/rulerMath";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function read(): number {
  const size = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  return size > 0 ? size : DEFAULT_REM_PX;
}

/** The root font size in px, read again on a window resize: rem-sized parts figure their room from it, as the system Ruler does. */
export function useRootFontPx(): number {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_REM_PX);
}
