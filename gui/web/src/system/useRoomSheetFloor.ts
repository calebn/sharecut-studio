import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
} from "react";
import { useResizeObserver } from "../ui/useResizeObserver";

const MODE = "data-room-sheet";

/**
 * Insets are measured against the layout viewport, which is what the fixed
 * sheet root is positioned in, so they hold on a page with no stage frame.
 * The bottom inset is for a dock row, the end inset for the landscape guest's
 * dock column.
 */
export function useRoomSheetFloor(
  roomRef: RefObject<HTMLElement | null>,
  open: boolean,
): void {
  const getDock = () =>
    roomRef.current?.querySelector<HTMLElement>(".sys-room-view-dock") ?? null;

  const clear = (root: HTMLElement) => {
    root.style.removeProperty("--room-sheet-bottom");
    root.style.removeProperty("--room-sheet-end");
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
        "--room-sheet-bottom",
        `${Math.max(0, clientHeight - rect.top)}px`,
      );
      root.style.removeProperty("--room-sheet-end");
      root.setAttribute(MODE, "bottom");
      return;
    }
    const rtl = getComputedStyle(root).direction === "rtl";
    root.style.setProperty(
      "--room-sheet-end",
      `${Math.max(0, rtl ? rect.right : clientWidth - rect.left)}px`,
    );
    root.style.removeProperty("--room-sheet-bottom");
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
