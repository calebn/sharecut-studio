/**
 * Viewport shell breakpoints for Sharecut Studio (phone / tablet / desktop).
 * Align with docs/gui-mobile.md and CSS data-shell / .daw-shell--*.
 *
 * Prefer matchMedia (same CSS px as layout) over window.outerWidth. DevTools
 * device-metrics override can desync outer window size from the CSS viewport;
 * matchMedia + visualViewport follow the CSS viewport the shell must use.
 */

import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";

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
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "desktop";
  }
  return shellBreakpointFromMatchMedia(
    window.matchMedia(PHONE_MQ).matches,
    window.matchMedia(TABLET_MQ).matches,
  );
}

const subscribeShell = mediaQuerySubscription(
  [PHONE_MQ, TABLET_MQ],
  (onChange) => {
    window.addEventListener("resize", onChange);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      vv?.removeEventListener("resize", onChange);
    };
  },
);

const serverShell = (): ShellBreakpoint => "desktop";

/** CSS-px viewport width (visualViewport, then innerWidth). */
export function cssViewportWidth(): number {
  if (typeof window === "undefined") {
    return 0;
  }
  return window.visualViewport?.width ?? window.innerWidth;
}

export function useViewportClass(): ShellBreakpoint {
  return useMediaQueryStore(subscribeShell, readShell, serverShell);
}
