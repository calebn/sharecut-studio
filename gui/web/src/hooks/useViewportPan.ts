import { useEffect } from "react";

const PAN_EPSILON_PX = 1;
const ZOOM_EPSILON = 0.01;

function typing(): boolean {
  const focused = document.activeElement;
  return (
    focused instanceof HTMLElement &&
    (focused.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))
  );
}

function clear(root: HTMLElement): void {
  delete root.dataset.viewportPan;
  root.style.removeProperty("--viewport-pan-top");
  root.style.removeProperty("--viewport-pan-height");
}

function publish(viewport: VisualViewport): void {
  const root = document.documentElement;
  if (
    viewport.offsetTop <= PAN_EPSILON_PX ||
    viewport.scale > 1 + ZOOM_EPSILON ||
    root.dataset.keyboard === "open" ||
    typing()
  ) {
    clear(root);
    return;
  }
  root.dataset.viewportPan = "on";
  root.style.setProperty("--viewport-pan-top", `${viewport.offsetTop}px`);
  root.style.setProperty("--viewport-pan-height", `${viewport.height}px`);
}

/**
 * After a rotation Safari re-expands its chrome and leaves the visual viewport
 * `offsetTop` below the layout viewport's top for 3 to 10 s, with no page scroll
 * to undo, so the shell's top rows sit off screen (#1761). While that pan has no
 * keyboard, pinch zoom or focused field to explain it, publish it as
 * `--viewport-pan-top` and `--viewport-pan-height` with `data-viewport-pan` on
 * `<html>`; `base.css` then moves `<body>` down by the pan and sizes it to the
 * visible band, so the shell and every fixed child follow the visible screen.
 */
export function useViewportPan(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => publish(viewport);
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      clear(document.documentElement);
    };
  }, []);
}
