import { useEffect } from "react";
import { focusAndReveal } from "../ui/focusAndReveal";

const KEYBOARD_MIN_PX = 80;
const ZOOM_EPSILON = 0.01;

function revealFocused(): void {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest(".bottom-sheet"))
    focusAndReveal(focused);
}

function track(viewport: VisualViewport): () => void {
  const root = document.documentElement;
  let frame: number | null = null;
  const reveal = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      revealFocused();
    });
  };
  const clear = () => {
    delete root.dataset.keyboard;
    root.style.removeProperty("--keyboard-inset");
    root.style.removeProperty("--visual-viewport-top");
  };
  const update = () => {
    const layoutHeight = Math.max(window.innerHeight, root.clientHeight);
    const covered = layoutHeight - viewport.height;
    const inset = Math.max(0, covered - viewport.offsetTop);
    const open =
      viewport.scale <= 1 + ZOOM_EPSILON && covered >= KEYBOARD_MIN_PX;
    if (!open) {
      const wasOpen = root.dataset.keyboard === "open";
      clear();
      if (wasOpen) reveal();
      return;
    }
    root.dataset.keyboard = "open";
    root.style.setProperty("--keyboard-inset", `${inset}px`);
    root.style.setProperty("--visual-viewport-top", `${viewport.offsetTop}px`);
    reveal();
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    if (frame !== null) cancelAnimationFrame(frame);
    clear();
  };
}

let owners = 0;
let stop: (() => void) | null = null;

function acquire(viewport: VisualViewport): () => void {
  if (owners++ === 0) stop = track(viewport);
  return () => {
    if (--owners === 0) {
      stop?.();
      stop = null;
    }
  };
}

/**
 * While `active`, publish how much of the layout viewport the software keyboard
 * covers (`--keyboard-inset`) and where the visible part starts
 * (`--visual-viewport-top`), with `data-keyboard="open"` on `<html>`.
 * Mobile Safari shrinks only the visual viewport, so a fixed sheet sized from the
 * layout viewport slides its header under the browser chrome (#1335).
 * iOS 17 also shrinks `innerHeight` with the keyboard and pans the visual
 * viewport by `offsetTop`, so the layout height is the larger of `innerHeight`
 * and the root's `clientHeight`, and the keyboard is what the visual viewport
 * does not cover, whatever its `offsetTop` (#1362).
 * A pinch zoom also shrinks the visual viewport and is not a keyboard.
 * The values live on `<html>`, so nested sheets share one tracker: it starts
 * with the first active caller and stops with the last.
 */
export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) return;
    return acquire(viewport);
  }, [active]);
}
