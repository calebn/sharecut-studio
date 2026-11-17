import { useEffect, useLayoutEffect } from "react";
import { useViewportClass } from "../../hooks/useViewportClass";
import { useViewportPan } from "../../hooks/useViewportPan";
import { useDawStore } from "../../state/dawStore";
import type { ShellBreakpoint } from "../../state/types";
import type { PlayerPlacement } from "./playerPlacement";

/**
 * The viewport class, written to the store and to `data-shell` on the root.
 * `shellBreakpoint` feeds many hooks and CSS rules, so the frame keeps
 * publishing it. Both effects are layout effects: the header's height depends
 * on `data-shell`, so it has to be on the root before the frame's first paint,
 * and a swap from Home to the frame in one commit must not let the old
 * component's later cleanup remove what the new one wrote.
 *
 * `surface: "home"` also marks the root `data-surface="home"`: Home has no tab
 * bar, Player or app header, so the sheets and toast that rest above that
 * chrome (stage-frame.css) rest on the screen edge instead.
 */
export function useShellAttributes(
  surface: "frame" | "home" = "frame",
): ShellBreakpoint {
  const shell = useViewportClass();
  useViewportPan();
  const setShellBreakpoint = useDawStore((s) => s.setShellBreakpoint);
  useLayoutEffect(() => {
    setShellBreakpoint(shell);
    document.documentElement.dataset.shell = shell;
  }, [shell, setShellBreakpoint]);
  useLayoutEffect(() => {
    if (surface === "home") document.documentElement.dataset.surface = "home";
    return () => {
      delete document.documentElement.dataset.shell;
      delete document.documentElement.dataset.surface;
    };
  }, [surface]);
  return shell;
}

/** `html[data-player="dock"]` while the Listen dock shows, so the sheets and the toast rest on it (stage-frame.css). */
export function usePlayerPlacementAttribute(placement: PlayerPlacement) {
  useEffect(() => {
    if (placement === "dock") document.documentElement.dataset.player = "dock";
    return () => {
      delete document.documentElement.dataset.player;
    };
  }, [placement]);
}
