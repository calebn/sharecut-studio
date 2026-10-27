import { useCallback, useState } from "react";
import { readScriptWidth, writeScriptWidth } from "../../utils/stagePref";

export const SCRIPT_WIDTH_DEFAULT_REM = 25;
export const SCRIPT_WIDTH_MIN_REM = 20;
export const SCRIPT_WIDTH_MAX_REM = 40;

export function clampScriptWidth(rem: number): number {
  return Math.min(
    SCRIPT_WIDTH_MAX_REM,
    Math.max(SCRIPT_WIDTH_MIN_REM, Math.round(rem * 100) / 100),
  );
}

/** The Script pane's width, kept per browser. Reset goes back to the default. */
export function useScriptSize() {
  const [widthRem, setWidth] = useState(() =>
    clampScriptWidth(readScriptWidth() ?? SCRIPT_WIDTH_DEFAULT_REM),
  );
  const resize = useCallback((rem: number) => {
    const next = clampScriptWidth(rem);
    setWidth(next);
    writeScriptWidth(next);
  }, []);
  const reset = useCallback(() => {
    setWidth(SCRIPT_WIDTH_DEFAULT_REM);
    writeScriptWidth(null);
  }, []);
  return { widthRem, resize, reset };
}
