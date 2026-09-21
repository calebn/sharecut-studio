import { type RefObject, useEffect } from "react";
import { execute } from "../commands/execute";

const TWO_FINGER_TAP_MAX_MS = 300;
const TWO_FINGER_TAP_MAX_MOVE_PX = 24;

/**
 * Two-finger tap → Undo. iOS system convention.
 * Attaches to the given element (or document) and triggers history.undo
 * on a quick two-finger tap with minimal movement.
 */
export function useTwoFingerTap(ref?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref?.current ?? document;
    let startTime = 0;
    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        startTime = Date.now();
        // Midpoint of the two touches
        startX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        startY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        tracking = true;
      } else {
        tracking = false;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 2) {
        tracking = false;
        return;
      }
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dx = midX - startX;
      const dy = midY - startY;
      if (Math.hypot(dx, dy) > TWO_FINGER_TAP_MAX_MOVE_PX) {
        tracking = false;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) {
        return;
      }
      tracking = false;
      // Both fingers lifted quickly with minimal movement = tap
      if (
        e.touches.length === 0 &&
        Date.now() - startTime < TWO_FINGER_TAP_MAX_MS
      ) {
        e.preventDefault();
        void execute("history.undo", {}, { skipWhen: true });
      }
    };

    el.addEventListener("touchstart", onTouchStart as EventListener, {
      passive: true,
    });
    el.addEventListener("touchmove", onTouchMove as EventListener, {
      passive: true,
    });
    el.addEventListener("touchend", onTouchEnd as EventListener);
    el.addEventListener("touchcancel", () => {
      tracking = false;
    });

    return () => {
      el.removeEventListener("touchstart", onTouchStart as EventListener);
      el.removeEventListener("touchmove", onTouchMove as EventListener);
      el.removeEventListener("touchend", onTouchEnd as EventListener);
    };
  }, [ref]);
}
