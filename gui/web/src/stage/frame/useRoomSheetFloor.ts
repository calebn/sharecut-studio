import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
} from "react";
import { useResizeObserver } from "../../ui/useResizeObserver";

const BOTTOM = "--room-sheet-bottom";
const END = "--room-sheet-end";
const MODE = "data-room-sheet";

/**
 * While the Room's Comments sheet is open, publishes how far its slot is inset
 * so the panel ends at the dock instead of covering it: from the viewport
 * bottom for a dock row, from the inline-end edge for the landscape guest's
 * dock column. Measured against the layout viewport, which is what the fixed
 * sheet root is positioned in, so it holds on a page with no stage frame.
 */
export function useRoomSheetFloor(
  roomRef: RefObject<HTMLElement | null>,
  open: boolean,
): void {
  const getDock = () =>
    roomRef.current?.querySelector<HTMLElement>(".sys-room-view-dock") ?? null;

  const clear = (root: HTMLElement) => {
    root.style.removeProperty(BOTTOM);
    root.style.removeProperty(END);
    root.removeAttribute(MODE);
  };

  const measure = () => {
    const root = document.documentElement;
    const dock = open ? getDock() : null;
    const rect = dock?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      clear(root);
      return;
    }
    const { clientWidth, clientHeight } = root;
    if (rect.width > clientWidth / 2) {
      root.style.setProperty(
        BOTTOM,
        `${Math.max(0, clientHeight - rect.top)}px`,
      );
      root.style.removeProperty(END);
      root.setAttribute(MODE, "bottom");
      return;
    }
    const rtl = getComputedStyle(root).direction === "rtl";
    root.style.setProperty(
      END,
      `${Math.max(0, rtl ? rect.right : clientWidth - rect.left)}px`,
    );
    root.style.removeProperty(BOTTOM);
    root.setAttribute(MODE, "end");
  };

  useResizeObserver([roomRef, getDock], measure, open);

  useLayoutEffect(() => {
    measure();
  });

  const remeasure = useEffectEvent(measure);
  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    window.addEventListener("resize", remeasure);
    viewport?.addEventListener("resize", remeasure);
    return () => {
      window.removeEventListener("resize", remeasure);
      viewport?.removeEventListener("resize", remeasure);
    };
  }, [open]);

  useLayoutEffect(() => () => clear(document.documentElement), []);
}
