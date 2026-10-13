import { useEffect } from "react";
import { focusAndReveal } from "../ui/focusAndReveal";

const KEYBOARD_MIN_PX = 80;
const ZOOM_EPSILON = 0.01;

function revealFocused(): void {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest(".bottom-sheet"))
    focusAndReveal(focused);
}

/**
 * While `active`, publish how much of the layout viewport the software keyboard
 * covers (`--keyboard-inset`) and where the visible part starts
 * (`--visual-viewport-top`), with `data-keyboard="open"` on `<html>`.
 * Mobile Safari shrinks only the visual viewport, so a fixed sheet sized from the
 * layout viewport slides its header under the browser chrome (#1335).
 * A pinch zoom also shrinks the visual viewport and is not a keyboard.
 */
export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) return;
    const root = document.documentElement;
    const clear = () => {
      delete root.dataset.keyboard;
      root.style.removeProperty("--keyboard-inset");
      root.style.removeProperty("--visual-viewport-top");
    };
    const update = () => {
      const inset = window.innerHeight - viewport.height - viewport.offsetTop;
      const open =
        viewport.scale <= 1 + ZOOM_EPSILON && inset >= KEYBOARD_MIN_PX;
      if (!open) {
        const wasOpen = root.dataset.keyboard === "open";
        clear();
        if (wasOpen) requestAnimationFrame(revealFocused);
        return;
      }
      root.dataset.keyboard = "open";
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      root.style.setProperty(
        "--visual-viewport-top",
        `${viewport.offsetTop}px`,
      );
      requestAnimationFrame(revealFocused);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      clear();
    };
  }, [active]);
}
