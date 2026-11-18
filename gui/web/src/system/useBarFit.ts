import { type RefObject, useLayoutEffect } from "react";
import { useResizeObserver } from "../ui/useResizeObserver";

/**
 * How many things the bar can give up, in order (system.css has one rule per
 * level): 1 Status pill text, 2 the Following detail, 3 the skip buttons,
 * 4 the cuts, 5 the hear menu's chevron, 6 the other pills.
 */
export const MAX_FIT_LEVEL = 6;

/** The lowest level at which `fits` is true; the last level when none is. */
export function findFitLevel(
  fits: (level: number) => boolean,
  max: number = MAX_FIT_LEVEL,
): number {
  for (let level = 0; level < max; level += 1) {
    if (fits(level)) return level;
  }
  return max;
}

interface Box {
  left: number;
  right: number;
}

/** The status line's box when it is drawn (not visually hidden), else null. */
function statusPill(column: Element): Element | null {
  const holder = column.querySelector(".sys-player-status");
  if (!holder || getComputedStyle(holder).position === "absolute") return null;
  return holder;
}

/** The span the visible children of a column take, or null when it holds none. */
function extent(column: Element): Box | null {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const child of Array.from(column.children)) {
    // A status squeezed to nothing still has its pill; a hidden one is 1 px.
    const drawn = child.classList.contains("sys-player-status")
      ? statusPill(column)?.firstElementChild
      : child;
    const rect = drawn?.getBoundingClientRect();
    if (!rect || rect.width <= 2) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  return left <= right ? { left, right } : null;
}

/**
 * True when what the bar draws at its current level is whole: no column's
 * content leaves the bar or runs into the next column, and the status text is
 * not cut short. Geometry only, so it does not depend on the font.
 */
export function barFits(host: HTMLElement): boolean {
  const bar = host.firstElementChild;
  if (!bar) return true;
  const outer = bar.getBoundingClientRect();
  const boxes = Array.from(bar.children).map(extent);
  let previous = outer.left;
  for (const box of boxes) {
    if (!box) continue;
    if (box.left < previous - 0.5) return false;
    previous = box.right;
  }
  if (previous > outer.right + 0.5) return false;
  const holder = statusPill(bar);
  const pill = holder?.firstElementChild;
  if (holder && pill) {
    const room = holder.getBoundingClientRect();
    const own = pill.getBoundingClientRect();
    if (own.right > room.right + 0.5 || own.left < room.left - 0.5)
      return false;
  }
  const text = holder?.querySelector(".sys-player-pill-text");
  // Visually hidden text (position: absolute, 1 px) is not cut short.
  return (
    !text ||
    getComputedStyle(text).position === "absolute" ||
    text.scrollWidth <= text.clientWidth
  );
}

/** Sets `data-fit` on `host` to the lowest level at which the bar fits. */
export function fitBar(host: HTMLElement): void {
  host.dataset.fit = String(
    findFitLevel((level) => {
      host.dataset.fit = String(level);
      return barFits(host);
    }),
  );
}

/**
 * Sets `data-fit` on the bar's host before the first paint, and again when what
 * the bar holds changes (every render), when it resizes, when an attribute of
 * `<html>` changes (the text size) and when the fonts finish loading. Pass
 * `on` false for the dock and the expanded form: no attribute, no observers.
 */
export function useBarFit(ref: RefObject<HTMLElement | null>, on: boolean) {
  // No dependency list: the bar's contents are whatever its props render.
  useLayoutEffect(() => {
    const host = ref.current;
    if (!on || !host) return;
    fitBar(host);
  });
  useResizeObserver(
    ref,
    () => {
      if (ref.current) fitBar(ref.current);
    },
    on,
  );
  useLayoutEffect(() => {
    const host = ref.current;
    if (!on || !host) return;
    const refit = () => fitBar(host);
    // A text-size or theme change sets an attribute on <html>: the widths of the
    // contents change, the bar's does not.
    const root = new MutationObserver(refit);
    root.observe(document.documentElement, { attributes: true });
    const fonts = document.fonts;
    void fonts?.ready.then(refit);
    fonts?.addEventListener?.("loadingdone", refit);
    return () => {
      root.disconnect();
      fonts?.removeEventListener?.("loadingdone", refit);
    };
  }, [ref, on]);
}
