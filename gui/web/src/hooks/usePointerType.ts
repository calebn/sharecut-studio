import { useLayoutEffect } from "react";
import { useDawStore } from "../state/dawStore";
import type { PointerKind } from "../state/types";

export type { PointerKind };

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
 * Initial input kind from the `(any-pointer: coarse)` capability query, so
 * the value is correct on first paint — before any pointer event has been
 * observed. Falls back to "fine" outside a browser (SSR/tests without
 * matchMedia).
 */
export function initialPointerKind(): PointerKind {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "fine";
  }
  return window.matchMedia("(any-pointer: coarse)").matches ? "coarse" : "fine";
}

/**
 * Track the last-used pointing device: fine (mouse/pen) vs coarse (touch).
 *
 * Initializes from the `(any-pointer: coarse)` capability query, then updates
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
  useLayoutEffect(() => {
    // Capability baseline before first paint; live updates after.
    useDawStore.getState().setPointerKind(initialPointerKind());
    const onPointer = (e: PointerEvent) => {
      const kind = pointerKindFromPointerType(e.pointerType);
      if (kind !== null) {
        useDawStore.getState().setPointerKind(kind);
      }
    };
    window.addEventListener("pointerdown", onPointer, { passive: true });
    window.addEventListener("pointermove", onPointer, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("pointermove", onPointer);
    };
  }, []);
  return pointerKind;
}
