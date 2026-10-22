import { useEffect } from "react";

const PAN_EPSILON_PX = 1;
const ZOOM_EPSILON = 0.01;

function fieldFocused(): boolean {
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
    fieldFocused()
  ) {
    clear(root);
    return;
  }
  root.dataset.viewportPan = "on";
  root.style.setProperty("--viewport-pan-top", `${viewport.offsetTop}px`);
  root.style.setProperty("--viewport-pan-height", `${viewport.height}px`);
}

/**
 * After a rotation Safari leaves the visual viewport `offsetTop` below the layout
 * top for 3 to 20 s, with no page scroll to undo it, so the fixed shell's top rows
 * sit off screen (#1761). Publish a pan that no keyboard, pinch zoom or focused
 * field explains; `layout.css` moves the shell to the visible band. It reads the
 * state a frame after the event so `useKeyboardInset` has already run.
 */
export function useViewportPan(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame: number | null = null;
    const update = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        publish(viewport);
      });
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    publish(viewport);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      if (frame !== null) cancelAnimationFrame(frame);
      clear(document.documentElement);
    };
  }, []);
}
