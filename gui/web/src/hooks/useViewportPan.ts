import { useEffect } from "react";

const PAN_EPSILON_PX = 1;
const ZOOM_EPSILON = 0.01;
const SETTLE_MS = 1500;

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

/** The pan to publish, or null when nothing but a pan explains the offset. */
function panKey(viewport: VisualViewport): string | null {
  if (
    viewport.offsetTop <= PAN_EPSILON_PX ||
    viewport.scale > 1 + ZOOM_EPSILON ||
    document.documentElement.dataset.keyboard === "open" ||
    fieldFocused()
  ) {
    return null;
  }
  return `${viewport.offsetTop}px ${viewport.height}px`;
}

function apply(key: string | null): void {
  const root = document.documentElement;
  if (key === null) {
    clear(root);
    return;
  }
  const [top, height] = key.split(" ");
  root.dataset.viewportPan = "on";
  root.style.setProperty("--viewport-pan-top", top);
  root.style.setProperty("--viewport-pan-height", height);
}

/**
 * After a rotation Safari leaves the visual viewport `offsetTop` below the layout
 * top for 3 to 20 s, with no page scroll to undo it, so the fixed shell's top rows
 * sit off screen (#1761). Publish a pan that no keyboard, pinch zoom or focused
 * field explains; `layout.css` moves the shell to the visible band. Safari starts
 * and ends the pan without an event, so after any trigger a frame loop re-reads it
 * while a pan is engaged and for `SETTLE_MS` after, and writes only on a change.
 * A frame runs after the event, so `useKeyboardInset` has already run.
 */
export function useViewportPan(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame: number | null = null;
    let deadline = 0;
    let published = panKey(viewport);
    const tick = (timestamp: number) => {
      frame = null;
      const next = panKey(viewport);
      if (next !== published) {
        published = next;
        apply(next);
      }
      if (next !== null || timestamp < deadline)
        frame = requestAnimationFrame(tick);
    };
    const kick = () => {
      deadline = performance.now() + SETTLE_MS;
      if (frame === null) frame = requestAnimationFrame(tick);
    };
    const targets: [EventTarget, string, AddEventListenerOptions?][] = [
      [viewport, "resize"],
      [viewport, "scroll"],
      [document, "focusin"],
      [document, "focusout"],
      [window, "orientationchange"],
      [window, "resize"],
      [document, "visibilitychange"],
      [document, "pointerup", { capture: true, passive: true }],
    ];
    for (const [target, type, options] of targets) {
      target.addEventListener(type, kick, options);
    }
    apply(published);
    kick();
    return () => {
      for (const [target, type, options] of targets) {
        target.removeEventListener(type, kick, options);
      }
      if (frame !== null) cancelAnimationFrame(frame);
      clear(document.documentElement);
    };
  }, []);
}
