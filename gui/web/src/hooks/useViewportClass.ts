/**
 * Viewport shell breakpoints for Sharecut Studio (phone / tablet / desktop).
 * Align with docs/gui-mobile.md and CSS data-shell / .daw-shell--*.
 *
 * Prefer matchMedia (same CSS px as layout) over window.outerWidth. DevTools
 * device-metrics override can desync outer window size from the CSS viewport;
 * matchMedia + visualViewport follow the CSS viewport the shell must use.
 */

import { useEffect, useState } from "react";

export type ShellBreakpoint = "phone" | "tablet" | "desktop";

export const PHONE_MAX_PX = 767;
export const TABLET_MAX_PX = 1100;

export const PHONE_MQ = `(max-width: ${PHONE_MAX_PX}px)`;
export const TABLET_MQ = `(max-width: ${TABLET_MAX_PX}px)`;

export function shellBreakpointFromWidth(width: number): ShellBreakpoint {
  if (width <= PHONE_MAX_PX) {
    return "phone";
  }
  if (width <= TABLET_MAX_PX) {
    return "tablet";
  }
  return "desktop";
}

/** Classify from matchMedia results (phone ⊆ tablet width band). */
export function shellBreakpointFromMatchMedia(
  phoneMatches: boolean,
  tabletMatches: boolean,
): ShellBreakpoint {
  if (phoneMatches) {
    return "phone";
  }
  if (tabletMatches) {
    return "tablet";
  }
  return "desktop";
}

function readShell(): ShellBreakpoint {
  if (typeof window === "undefined") {
    return "desktop";
  }
  return shellBreakpointFromMatchMedia(
    window.matchMedia(PHONE_MQ).matches,
    window.matchMedia(TABLET_MQ).matches,
  );
}

/** CSS-px viewport width (visualViewport, then innerWidth). */
export function cssViewportWidth(): number {
  if (typeof window === "undefined") {
    return 0;
  }
  return window.visualViewport?.width ?? window.innerWidth;
}

export function useViewportClass(): ShellBreakpoint {
  const [shell, setShell] = useState<ShellBreakpoint>(() => readShell());

  useEffect(() => {
    const phoneMq = window.matchMedia(PHONE_MQ);
    const tabletMq = window.matchMedia(TABLET_MQ);

    const update = () => {
      setShell(
        shellBreakpointFromMatchMedia(phoneMq.matches, tabletMq.matches),
      );
    };

    update();
    phoneMq.addEventListener("change", update);
    tabletMq.addEventListener("change", update);
    window.addEventListener("resize", update);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    return () => {
      phoneMq.removeEventListener("change", update);
      tabletMq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
    };
  }, []);

  return shell;
}
