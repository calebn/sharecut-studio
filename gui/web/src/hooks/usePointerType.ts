import { useLayoutEffect, useRef } from "react";
import { useDawStore } from "../state/dawStore";
import type { PointerKind } from "../state/types";
import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";

export type { PointerKind };

const PRIMARY_FINE_QUERY = "(pointer: fine)";
const ANY_COARSE_QUERY = "(any-pointer: coarse)";

/**
 * Map a PointerEvent `pointerType` to a coarse/fine input kind.
 * mouse/pen -> "fine", touch -> "coarse". Returns null for empty or unknown
 * values so callers keep the last known kind instead of flipping on
 * synthetic/defensive events.
 */
export function pointerKindFromPointerType(
  pointerType: string | null | undefined,
): PointerKind | null {
  switch (pointerType) {
    case "mouse":
    case "pen":
      return "fine";
    case "touch":
      return "coarse";
    default:
      return null;
  }
}

/**
 * Initial input kind from capability queries, so the value is correct on
 * first paint — before any pointer event has been observed. A primary fine
 * pointer wins on hybrid devices; otherwise any coarse pointer is enough to
 * choose coarse. Falls back to "fine" outside a browser (SSR/tests without
 * matchMedia).
 */
export function initialPointerKind(): PointerKind {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "fine";
  }
  if (window.matchMedia(PRIMARY_FINE_QUERY).matches) {
    return "fine";
  }
  return window.matchMedia(ANY_COARSE_QUERY).matches ? "coarse" : "fine";
}

const subscribePointerCapabilities = mediaQuerySubscription([
  PRIMARY_FINE_QUERY,
  ANY_COARSE_QUERY,
]);
const serverPointerKind = (): PointerKind => "fine";

/**
 * Track the last-used pointing device: fine (mouse/pen) vs coarse (touch).
 *
 * Initializes from primary-fine then any-coarse capability queries, then updates
 * live on real pointerdown/pointermove events, so mid-session switches
 * (pen <-> finger) are reflected immediately. Unknown/empty `pointerType`
 * values keep the last known kind.
 *
 * This drives input-mode adaptation only (e.g. the presence `mobile_mode`
 * payload, touch-sized targets). It must never gate presence visibility:
 * remote collaborators' cursors/viewports/selections always render
 * regardless of local input type.
 */
export function usePointerType(): PointerKind {
  const pointerKind = useDawStore((s) => s.pointerKind);
  const pointerSeen = useRef(false);
  const capabilityKind = useMediaQueryStore(
    subscribePointerCapabilities,
    initialPointerKind,
    serverPointerKind,
  );
  useLayoutEffect(() => {
    // Capability baseline before first paint; live updates after.
    if (!pointerSeen.current) {
      useDawStore.getState().setPointerKind(capabilityKind);
    }
    const onPointer = (e: PointerEvent) => {
      const kind = pointerKindFromPointerType(e.pointerType);
      if (kind !== null && useDawStore.getState().pointerKind !== kind) {
        useDawStore.getState().setPointerKind(kind);
      }
      if (kind !== null) {
        pointerSeen.current = true;
      }
    };
    window.addEventListener("pointerdown", onPointer, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointermove", onPointer, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("pointermove", onPointer, true);
    };
  }, [capabilityKind]);
  return pointerKind;
}
