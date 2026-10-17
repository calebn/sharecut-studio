/**
 * Bottom panel (`--tabs-height`) preference.
 * Persists rem height in localStorage; clamps so timeline and tabs stay usable.
 * Until the user sets a preference, CSS defaults (incl. tablet `min()`) apply.
 */

import { useCallback, useEffect, useState } from "react";
import { readLocal } from "../utils/storage";

export const TABS_HEIGHT_STORAGE_KEY = "sharecut.tabsHeight";
export const DEFAULT_TABS_HEIGHT_REM = 12.5;
export const MIN_TABS_HEIGHT_REM = 8;
/** Max fraction of shell space below transport+status. */
export const MAX_TABS_FRACTION = 0.6;
/** The fraction of that space a short window's CSS default takes (`responsive.css`). */
export const SHORT_DEFAULT_TABS_FRACTION = 0.38;
export const SHORT_MIN_TABS_HEIGHT_REM = 4.5;

export function remToPx(rem: number): number {
  if (typeof document === "undefined") {
    return rem * 16;
  }
  const root = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize || "16",
  );
  return rem * (Number.isFinite(root) && root > 0 ? root : 16);
}

export function pxToRem(px: number): number {
  return px / (remToPx(1) || 16);
}

/**
 * The smallest panel the splitter reaches: 8rem, or in a short window (whose
 * CSS default is already under 8rem) 4.5rem, the tab bar and a peek of its
 * panel. Never above that window's own default, so a drag can shrink it.
 */
export function minTabsHeightRem(availableBelowChromePx: number): number {
  const shortDefault = pxToRem(
    availableBelowChromePx * SHORT_DEFAULT_TABS_FRACTION,
  );
  return shortDefault >= MIN_TABS_HEIGHT_REM
    ? MIN_TABS_HEIGHT_REM
    : Math.min(shortDefault, SHORT_MIN_TABS_HEIGHT_REM);
}

export function clampTabsHeightRem(
  rem: number,
  availableBelowChromePx: number,
): number {
  if (!Number.isFinite(rem)) {
    return DEFAULT_TABS_HEIGHT_REM;
  }
  const minRem = minTabsHeightRem(availableBelowChromePx);
  const maxRem = Math.max(
    minRem,
    pxToRem(availableBelowChromePx * MAX_TABS_FRACTION),
  );
  return Math.min(maxRem, Math.max(minRem, rem));
}

function readStoredRem(): number | null {
  const raw = readLocal(TABS_HEIGHT_STORAGE_KEY);
  if (raw == null) {
    return null;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function writeStoredRem(rem: number | null): void {
  try {
    if (rem == null) {
      localStorage.removeItem(TABS_HEIGHT_STORAGE_KEY);
    } else {
      localStorage.setItem(TABS_HEIGHT_STORAGE_KEY, String(rem));
    }
  } catch {
    // ignore
  }
}

function availableBelowChromePx(): number {
  if (typeof window === "undefined") {
    return 800;
  }
  // The short-window CSS default reads these two off the root as well.
  const root = document.documentElement;
  const transport =
    Number.parseFloat(
      getComputedStyle(root).getPropertyValue("--transport-height"),
    ) || 2.75;
  const status =
    Number.parseFloat(
      getComputedStyle(root).getPropertyValue("--status-height"),
    ) || 1.75;
  return Math.max(0, window.innerHeight - remToPx(transport + status));
}

function applyTabsHeight(rem: number | null): void {
  if (typeof document === "undefined") {
    return;
  }
  if (rem == null) {
    document.documentElement.style.removeProperty("--tabs-height");
  } else {
    document.documentElement.style.setProperty("--tabs-height", `${rem}rem`);
  }
}

/** Apply stored height once at boot when a preference exists. */
export function initTabsHeight(): number | null {
  const stored = readStoredRem();
  if (stored == null) {
    return null;
  }
  const rem = clampTabsHeightRem(stored, availableBelowChromePx());
  if (rem !== stored) writeStoredRem(rem);
  applyTabsHeight(rem);
  return rem;
}

export function useTabsHeight(): {
  heightRem: number;
  setHeightRem: (rem: number) => void;
  resetHeight: () => void;
  minRem: number;
  maxRem: number;
  userSet: boolean;
} {
  const [heightRem, setHeightState] = useState(() => {
    const stored = initTabsHeight();
    return stored ?? DEFAULT_TABS_HEIGHT_REM;
  });
  const [userSet, setUserSet] = useState(() => readStoredRem() != null);
  const [maxRem, setMaxRem] = useState(() =>
    clampTabsHeightRem(999, availableBelowChromePx()),
  );
  const [minRem, setMinRem] = useState(() =>
    minTabsHeightRem(availableBelowChromePx()),
  );

  useEffect(() => {
    const syncMax = () => {
      const avail = availableBelowChromePx();
      const nextMax = clampTabsHeightRem(999, avail);
      setMaxRem(nextMax);
      setMinRem(minTabsHeightRem(avail));
      setHeightState((prev) => {
        if (!userSet) {
          return prev;
        }
        const next = clampTabsHeightRem(prev, avail);
        if (next !== prev) {
          applyTabsHeight(next);
          writeStoredRem(next);
        }
        return next;
      });
    };
    syncMax();
    window.addEventListener("resize", syncMax);
    return () => window.removeEventListener("resize", syncMax);
  }, [userSet]);

  const setHeightRem = useCallback((rem: number) => {
    const next = clampTabsHeightRem(rem, availableBelowChromePx());
    setUserSet(true);
    setHeightState(next);
    writeStoredRem(next);
    applyTabsHeight(next);
  }, []);

  const resetHeight = useCallback(() => {
    setUserSet(false);
    setHeightState(DEFAULT_TABS_HEIGHT_REM);
    writeStoredRem(null);
    applyTabsHeight(null);
  }, []);

  return {
    heightRem,
    setHeightRem,
    resetHeight,
    minRem,
    maxRem,
    userSet,
  };
}
