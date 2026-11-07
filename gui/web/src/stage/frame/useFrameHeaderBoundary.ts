import { type RefObject, useLayoutEffect } from "react";
import type { ShellBreakpoint } from "../../state/types";
import { useResizeObserver } from "../../ui/useResizeObserver";

export function useFrameHeaderBoundary(
  frameRef: RefObject<HTMLDivElement | null>,
  shell: ShellBreakpoint,
): void {
  const getHeader = () =>
    frameRef.current?.querySelector<HTMLElement>(
      ":scope > .stage-frame-header",
    ) ?? null;

  const measure = () => {
    const frame = frameRef.current;
    const header = getHeader();
    const root = frame?.ownerDocument.documentElement;
    if (!frame || !header || !root || shell !== "phone") {
      root?.style.removeProperty("--frame-header-end");
      return;
    }

    const frameRect = frame.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const inset = headerRect.bottom - frameRect.top;
    if (
      frameRect.width <= 0 ||
      frameRect.height <= 0 ||
      headerRect.width <= 0 ||
      headerRect.height <= 0 ||
      !Number.isFinite(inset) ||
      inset < 0
    ) {
      root.style.removeProperty("--frame-header-end");
      return;
    }

    root.style.setProperty("--frame-header-end", `${inset}px`);
  };

  useResizeObserver([frameRef, getHeader], measure, shell === "phone");

  useLayoutEffect(() => {
    measure();
  });

  useLayoutEffect(
    () => () => {
      document.documentElement.style.removeProperty("--frame-header-end");
    },
    [],
  );
}
