import { useEffect } from "react";

const OFFSET_EPSILON_PX = 1;
const ZOOM_EPSILON = 0.01;

function typing(): boolean {
  const focused = document.activeElement;
  return (
    focused instanceof HTMLElement &&
    (focused.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))
  );
}

function realign(viewport: VisualViewport): void {
  if (
    viewport.offsetTop <= OFFSET_EPSILON_PX ||
    viewport.scale > 1 + ZOOM_EPSILON ||
    document.documentElement.dataset.keyboard === "open" ||
    typing()
  )
    return;
  window.scrollTo(0, 0);
}

/**
 * The shell is fixed and never scrolls, so a visual viewport panned down from the
 * layout viewport's top is Safari's chrome re-expanding after a rotation, not
 * something the user did; for 3 to 10 s the shell sits that far above the screen
 * (#1761). Scrolling the page back to the top realigns the two. A pinch zoom, an
 * open keyboard or a focused field is a real pan and is left alone.
 */
export function useRealignViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const onChange = () => realign(viewport);
    viewport.addEventListener("resize", onChange);
    viewport.addEventListener("scroll", onChange);
    window.addEventListener("orientationchange", onChange);
    return () => {
      viewport.removeEventListener("resize", onChange);
      viewport.removeEventListener("scroll", onChange);
      window.removeEventListener("orientationchange", onChange);
    };
  }, []);
}
